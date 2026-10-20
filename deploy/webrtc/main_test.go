package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type proxyStripListener struct{ net.Listener }

func (l proxyStripListener) Accept() (net.Conn, error) {
	c, e := l.Listener.Accept()
	if e != nil {
		return nil, e
	}
	header := make([]byte, 28)
	if _, e = io.ReadFull(c, header); e != nil {
		c.Close()
		return nil, e
	}
	if !bytes.Equal(header[:12], proxySig) || header[13] != 0x11 {
		c.Close()
		return nil, io.ErrUnexpectedEOF
	}
	return c, nil
}
func TestProxyHeader(t *testing.T) {
	for _, ip := range []string{"192.0.2.15", "240b:10:f402:ca00::1"} {
		v, e := proxyHeader(ip)
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(v[:12], proxySig) {
			t.Fatal("bad proxy preface")
		}
		if net.ParseIP(ip).To4() != nil && len(v) != 28 {
			t.Fatal("bad tcp4")
		}
		if net.ParseIP(ip).To4() == nil && len(v) != 52 {
			t.Fatal("bad tcp6")
		}
	}
}
func TestPeerDataChannelToWebsocketRoundTrip(t *testing.T) {
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	packets := make(chan []byte, 1)
	fake := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "https://share.pexserver.com" || r.Header.Get("Sec-Websocket-Protocol") == "" {
			http.Error(w, "unauthorized", 403)
			return
		}
		up := websocket.Upgrader{Subprotocols: []string{protocol}, CheckOrigin: func(r *http.Request) bool { return true }}
		ws, e := up.Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"ready","protocol":"fileshare-upload-v2"}`))
		_, msg, e := ws.ReadMessage()
		if e == nil {
			packets <- msg
			_ = ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"done","offset":16000}`))
		}
	})}
	go fake.Serve(proxyStripListener{ln})
	defer fake.Close()
	a := &app{conf: settings{
		bind: "127.0.0.1:19883", upstream: ln.Addr().String(), source: "127.0.0.1",
		origin: "https://share.pexserver.com", virtualHost: "upload-v6.pexserver.com:8443",
		stun: "", maxPeers: 4,
	}}
	signal := httptest.NewServer(http.HandlerFunc(a.offer))
	defer signal.Close()
	browser, e := webrtc.NewPeerConnection(webrtc.Configuration{})
	if e != nil {
		t.Fatal(e)
	}
	defer browser.Close()
	dc, e := browser.CreateDataChannel("fileshare", nil)
	if e != nil {
		t.Fatal(e)
	}
	opened := make(chan struct{}, 1)
	messages := make(chan string, 4)
	dc.OnOpen(func() { opened <- struct{}{} })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			messages <- string(m.Data)
		}
	})
	offer, e := browser.CreateOffer(nil)
	if e != nil {
		t.Fatal(e)
	}
	gather := webrtc.GatheringCompletePromise(browser)
	if e = browser.SetLocalDescription(offer); e != nil {
		t.Fatal(e)
	}
	select {
	case <-gather:
	case <-time.After(8 * time.Second):
		t.Fatal("browser ICE gathering timed out")
	}
	in := offerRequest{Offer: *browser.LocalDescription(), ID: "123e4567-e89b-12d3-a456-426614174000", Ticket: strings.Repeat("a", 32), ClientIP: "192.0.2.42"}
	b, _ := json.Marshal(in)
	res, e := http.Post(signal.URL, "application/json", bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("signaling %d: %s", res.StatusCode, body)
	}
	var answer offerResponse
	if e = json.NewDecoder(res.Body).Decode(&answer); e != nil {
		t.Fatal(e)
	}
	if e = browser.SetRemoteDescription(answer.Answer); e != nil {
		t.Fatal(e)
	}
	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		t.Fatal("RTC datachannel did not open")
	}
	select {
	case msg := <-messages:
		if !strings.Contains(msg, "ready") {
			t.Fatalf("missing ready %s", msg)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no ready from A8 backend")
	}
	want := bytes.Repeat([]byte{42}, 16000)
	for pos := 0; pos < len(want); pos += 2000 {
		count := 2000
		fragment := make([]byte, 12+count)
		binary.BigEndian.PutUint32(fragment[:4], 1)
		binary.BigEndian.PutUint32(fragment[4:8], uint32(len(want)))
		binary.BigEndian.PutUint32(fragment[8:12], uint32(pos))
		copy(fragment[12:], want[pos:pos+count])
		if e = dc.Send(fragment); e != nil {
			t.Fatal(e)
		}
	}
	select {
	case got := <-packets:
		if !bytes.Equal(got, want) {
			t.Fatalf("forwarded frame mismatch %d", len(got))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("upstream never received assembled frame")
	}
	for i := 0; i < 3; i++ {
		select {
		case got := <-messages:
			if strings.Contains(got, "done") {
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no RTC ACK from websocket")
		}
	}
	t.Fatal("no completion ack")
}
