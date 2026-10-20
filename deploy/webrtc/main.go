package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

const protocol = "fileshare-upload-v2"
const maxFrame = 8*1024*1024 + 256
const maxOfferBytes = 140000

var validID = regexp.MustCompile(`^[a-f0-9-]{36}$`)
var proxySig = []byte{13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10}

type settings struct {
	bind, upstream, source, origin, virtualHost, stun string
	maxPeers                                          int32
}
type offerRequest struct {
	Offer    webrtc.SessionDescription `json:"offer"`
	ID       string                    `json:"id"`
	Ticket   string                    `json:"ticket"`
	ClientIP string                    `json:"clientIp"`
}
type offerResponse struct {
	Answer webrtc.SessionDescription `json:"answer"`
}
type app struct {
	conf   settings
	active atomic.Int32
}

func proxyHeader(sourceIP string) ([]byte, error) {
	ip := net.ParseIP(sourceIP)
	if ip == nil {
		return nil, fmt.Errorf("invalid client IP")
	}
	dst := net.ParseIP("100.69.76.52")
	if ip4 := ip.To4(); ip4 != nil {
		b := make([]byte, 28)
		copy(b, proxySig)
		b[12] = 0x21
		b[13] = 0x11
		binary.BigEndian.PutUint16(b[14:], 12)
		copy(b[16:20], ip4)
		copy(b[20:24], dst.To4())
		binary.BigEndian.PutUint16(b[24:], 50000)
		binary.BigEndian.PutUint16(b[26:], 8100)
		return b, nil
	}
	b := make([]byte, 52)
	copy(b, proxySig)
	b[12] = 0x21
	b[13] = 0x21
	binary.BigEndian.PutUint16(b[14:], 36)
	copy(b[16:32], ip.To16())
	copy(b[32:48], net.ParseIP("fd7a:115c:a1e0::bb3b:4c36").To16())
	binary.BigEndian.PutUint16(b[48:], 50000)
	binary.BigEndian.PutUint16(b[50:], 8100)
	return b, nil
}

func (app *app) upstreamWS(r offerRequest) (*websocket.Conn, error) {
	header, err := proxyHeader(r.ClientIP)
	if err != nil {
		return nil, err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 8 * time.Second,
		Subprotocols:     []string{protocol, r.Ticket},
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			d := &net.Dialer{Timeout: 5 * time.Second, LocalAddr: &net.TCPAddr{IP: net.ParseIP(app.conf.source)}}
			conn, e := d.DialContext(ctx, "tcp", app.conf.upstream)
			if e != nil {
				return nil, e
			}
			if _, e = conn.Write(header); e != nil {
				conn.Close()
				return nil, e
			}
			return conn, nil
		},
	}
	head := http.Header{}
	head.Set("Origin", app.conf.origin)
	url := "ws://" + app.conf.virtualHost + "/api/uploads/" + r.ID + "/stream"
	ws, resp, err := dialer.Dial(url, head)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("A8 WebSocket refused: %s", resp.Status)
		}
		return nil, err
	}
	ws.SetReadLimit(maxFrame)
	return ws, nil
}

// Ordered, reliable DataChannels carry a bounded set of fragments for one
// existing FileShare binary WebSocket frame. Outbound responses remain text.
type bridge struct {
	mu     sync.Mutex
	ws     *websocket.Conn
	dc     *webrtc.DataChannel
	id     uint32
	total  uint32
	have   uint32
	buf    []byte
	closed atomic.Bool
}

func (b *bridge) close() {
	if b.closed.Swap(true) {
		return
	}
	b.mu.Lock()
	if b.ws != nil {
		_ = b.ws.Close()
	}
	b.mu.Unlock()
}
func (b *bridge) handle(msg webrtc.DataChannelMessage) {
	if b.closed.Load() {
		return
	}
	if msg.IsString {
		if len(msg.Data) > 256 {
			b.close()
			return
		}
		b.mu.Lock()
		err := b.ws.WriteMessage(websocket.TextMessage, msg.Data)
		b.mu.Unlock()
		if err != nil {
			b.close()
		}
		return
	}
	p := msg.Data
	if len(p) < 12 || len(p) > 16400 {
		b.close()
		return
	}
	id := binary.BigEndian.Uint32(p[:4])
	total := binary.BigEndian.Uint32(p[4:8])
	offset := binary.BigEndian.Uint32(p[8:12])
	if total == 0 || total > maxFrame {
		b.close()
		return
	}
	if offset == 0 {
		if b.have != 0 {
			b.close()
			return
		}
		b.id = id
		b.total = total
		b.have = 0
		b.buf = make([]byte, total)
	}
	if b.id != id || b.total != total || b.have != offset || uint64(offset)+uint64(len(p)-12) > uint64(total) {
		b.close()
		return
	}
	copy(b.buf[offset:], p[12:])
	b.have += uint32(len(p) - 12)
	if b.have == b.total {
		frame := b.buf
		b.buf = nil
		b.have = 0
		b.total = 0
		b.mu.Lock()
		err := b.ws.WriteMessage(websocket.BinaryMessage, frame)
		b.mu.Unlock()
		if err != nil {
			b.close()
		}
	}
}
func (a *app) offer(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	if req.RemoteAddr == "" {
		http.Error(w, "forbidden", 403)
		return
	}
	remote, _, e := net.SplitHostPort(req.RemoteAddr)
	if e != nil || remote != "127.0.0.1" {
		http.Error(w, "loopback only", 403)
		return
	}
	if a.active.Add(1) > a.conf.maxPeers {
		a.active.Add(-1)
		http.Error(w, "too many sessions", 429)
		return
	}
	owned := true
	defer func() {
		if owned {
			a.active.Add(-1)
		}
	}()
	req.Body = http.MaxBytesReader(w, req.Body, maxOfferBytes)
	var offer offerRequest
	if err := json.NewDecoder(req.Body).Decode(&offer); err != nil {
		http.Error(w, "invalid offer", 400)
		return
	}
	if !validID.MatchString(offer.ID) || len(offer.Ticket) > 4096 || len(offer.Ticket) < 20 ||
		net.ParseIP(offer.ClientIP) == nil || offer.Offer.Type != webrtc.SDPTypeOffer || len(offer.Offer.SDP) > 130000 {
		http.Error(w, "invalid signaling", 400)
		return
	}
	conf := webrtc.Configuration{}
	if a.conf.stun != "" {
		conf.ICEServers = []webrtc.ICEServer{{URLs: []string{a.conf.stun}}}
	}
	peer, err := webrtc.NewPeerConnection(conf)
	if err != nil {
		http.Error(w, "RTC unavailable", 503)
		return
	}
	var once sync.Once
	release := func() { once.Do(func() { a.active.Add(-1); _ = peer.Close() }) }
	// Bound peer lifetime even after browsers disappear.
	time.AfterFunc(10*time.Minute, release)
	peer.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			ice := peer.SCTP().Transport().ICETransport()
			selected, err := ice.GetSelectedCandidatePair()
			if err != nil || selected == nil {
				log.Printf("ICE connected: selected pair unavailable")
			} else {
				log.Printf("ICE selected pair: local_type=%s remote_type=%s local_proto=%s remote_proto=%s relay=%t",
					selected.Local.Typ, selected.Remote.Typ,
					selected.Local.Protocol, selected.Remote.Protocol,
					selected.Local.Typ == webrtc.ICECandidateTypeRelay || selected.Remote.Typ == webrtc.ICECandidateTypeRelay)
			}
		}
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			go release()
		}
		if s == webrtc.PeerConnectionStateDisconnected {
			time.AfterFunc(15*time.Second, func() {
				if peer.ConnectionState() == webrtc.PeerConnectionStateDisconnected {
					release()
				}
			})
		}
	})
	peer.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "fileshare" {
			_ = dc.Close()
			return
		}
		dc.OnOpen(func() {
			ws, e := a.upstreamWS(offer)
			if e != nil {
				log.Printf("A8 websocket authorization/connect failed: %v", e)
				_ = dc.SendText(`{"type":"error","status":503,"error":"A8への接続を確認できません"}`)
				release()
				return
			}
			br := &bridge{ws: ws, dc: dc}
			dc.OnMessage(br.handle)
			dc.OnClose(func() { br.close(); release() })
			go func() {
				defer func() { br.close(); release() }()
				for {
					typ, message, e := ws.ReadMessage()
					if e != nil {
						return
					}
					if typ != websocket.TextMessage || len(message) > 65536 {
						return
					}
					if e = dc.SendText(string(message)); e != nil {
						return
					}
				}
			}()
		})
	})
	if err = peer.SetRemoteDescription(offer.Offer); err != nil {
		release()
		http.Error(w, "bad offer", 400)
		return
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		release()
		http.Error(w, "answer failed", 400)
		return
	}
	ready := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(answer); err != nil {
		release()
		http.Error(w, "RTC setup failed", 500)
		return
	}
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		release()
		http.Error(w, "ICE gather timeout", 504)
		return
	case <-req.Context().Done():
		release()
		return
	}
	owned = false
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(offerResponse{Answer: *peer.LocalDescription()})
}
func main() {
	max := int32(16)
	if v := os.Getenv("FILESHARE_RTC_MAX_PEERS"); v != "" {
		if n, e := strconv.ParseInt(v, 10, 32); e == nil && n > 0 && n <= 128 {
			max = int32(n)
		}
	}
	a := &app{conf: settings{
		bind:        "127.0.0.1:19883",
		upstream:    "100.69.76.52:8100",
		origin:      "https://share.pexserver.com",
		virtualHost: "upload-v6.pexserver.com:8443",
		stun:        "stun:stun.l.google.com:19302", maxPeers: max,
	}}
	if value := os.Getenv("FILESHARE_RTC_SOURCE"); value != "" {
		if net.ParseIP(value) == nil {
			log.Fatal("invalid rtc source")
		}
		a.conf.source = value
	}
	if value := os.Getenv("FILESHARE_RTC_UPSTREAM"); value != "" {
		if !strings.HasPrefix(value, "127.0.0.1:") {
			log.Fatal("RTC upstream override must be loopback")
		}
		a.conf.upstream = value
	}
	if os.Getenv("FILESHARE_RTC_BIND") != "" {
		log.Fatal("public bind override disabled")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/offer", a.offer)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method", 405)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	})
	srv := &http.Server{Addr: a.conf.bind, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 16 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second}
	log.Printf("FileShare WebRTC signaling on %s (UDP ICE only; no exposed TCP)", a.conf.bind)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
