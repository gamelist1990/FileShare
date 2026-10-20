package main

import (
 "bytes"
 "encoding/json"
 "fmt"
 "net"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
 "time"

 "github.com/pion/webrtc/v4"
)

func TestDirectDownloadViaDataChannel(t *testing.T) {
 ln,e:=net.Listen("tcp","127.0.0.1:0")
 if e!=nil {t.Fatal(e)}
 const length=16000*3+83
 payload:=bytes.Repeat([]byte{19},length)
 srv:=&http.Server{Handler:http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
  if r.URL.Path!="/api/internal/webrtc-download" {t.Errorf("wrong path %s",r.URL.Path);http.Error(w,"invalid",404);return}
  if r.Header.Get("X-FileShare-Direct-Ticket")!="signed-ticket-for-test-123456" {t.Error("missing capability");http.Error(w,"denied",403);return}
  w.Header().Set("Content-Length",fmt.Sprint(len(payload)))
  w.Write(payload)
 })}
 go srv.Serve(proxyStripListener{ln})
 defer srv.Close()
 a:=&app{conf:settings{upstream:ln.Addr().String(),source:"127.0.0.1",
  origin:"https://share.pexserver.com", virtualHost:"upload-v6.pexserver.com:8443",
  maxPeers:4}}
 signaling:=httptest.NewServer(http.HandlerFunc(a.offer));defer signaling.Close()
 peer,e:=webrtc.NewPeerConnection(webrtc.Configuration{});if e!=nil{t.Fatal(e)}
 defer peer.Close()
 dc,e:=peer.CreateDataChannel("fileshare-download",nil);if e!=nil{t.Fatal(e)}
 messages:=make(chan webrtc.DataChannelMessage,32)
 dc.OnMessage(func(msg webrtc.DataChannelMessage){messages<-msg})
 offer,e:=peer.CreateOffer(nil);if e!=nil{t.Fatal(e)}
 ready:=webrtc.GatheringCompletePromise(peer)
 peer.SetLocalDescription(offer)
 select{case <-ready:case <-time.After(8*time.Second):t.Fatal("gather timeout")}
 req:=offerRequest{Offer:*peer.LocalDescription(),ID:"123e4567-e89b-12d3-a456-426614174000",
  Ticket:"signed-ticket-for-test-123456",ClientIP:"192.0.2.41",Operation:"download"}
 data,_:=json.Marshal(req)
 response,e:=http.Post(signaling.URL,"application/json",bytes.NewReader(data))
 if e!=nil{t.Fatal(e)}
 defer response.Body.Close()
 if response.StatusCode!=200{t.Fatalf("signal status %d",response.StatusCode)}
 var answer offerResponse
 if e=json.NewDecoder(response.Body).Decode(&answer);e!=nil{t.Fatal(e)}
 if e=peer.SetRemoteDescription(answer.Answer);e!=nil{t.Fatal(e)}
 got:=make([]byte,0,len(payload))
 started,finished:=false,false
 timeout:=time.After(10*time.Second)
 for !finished {
  select {
  case m:=<-messages:
   if m.IsString {
    value:=string(m.Data)
    if strings.Contains(value,`"type":"start"`){started=true}
    if strings.Contains(value,`"type":"done"`){finished=true}
    if strings.Contains(value,`"type":"error"`){t.Fatalf("download failed: %s",value)}
   } else {got=append(got,m.Data...)}
  case <-timeout:t.Fatal("direct download timed out")
  }
 }
 if !started || !bytes.Equal(got,payload){t.Fatalf("direct download mismatch start=%t len=%d",started,len(got))}
}
