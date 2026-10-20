#!/usr/bin/env python3
"""Isolated loopback ingress benchmark with a deliberately slow fake A8.

No production credentials, routes or database are used. The temporary files and
listener are removed on exit. Example: python3 scripts/benchmark-edge-spool.py
  --receiver deploy/a1-edge-spool.py --mib 1024 --backend-mibps 5
This measures local receiver I/O and protocol overhead, not public WAN speed.
"""
import argparse,base64,hashlib,hmac,http.client,importlib.util,json,os,pathlib,secrets,shutil,socket,struct,tempfile,threading,time,uuid
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--receiver',default='deploy/a1-edge-spool.py')
parser.add_argument('--mib',type=int,default=128)
parser.add_argument('--backend-mibps',type=float,default=5)
args=parser.parse_args()
assert 1<=args.mib<=4096 and args.backend_mibps>=0.25
block=1024**2;size=args.mib*block
root=pathlib.Path(tempfile.mkdtemp(prefix='fileshare-edge-benchmark-'));os.chmod(root,0o700)
secret=secrets.token_hex(32);key=root/'key';key.write_text(secret);key.chmod(0o600)
os.environ.update(FILESHARE_EDGE_DATA_DIR=str(root/'a1'),FILESHARE_EDGE_SECRET_FILE=str(key),FILESHARE_EDGE_MIN_FREE='0',FILESHARE_EDGE_MAX_RESERVED=str(size*2))
spec=importlib.util.spec_from_file_location('spool',args.receiver);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.init_db()
server=m.EdgeHTTPServer(('127.0.0.1',0),m.EdgeHandler);port=server.server_port
m.EdgeHandler.log_message=lambda *a:None
threading.Thread(target=server.serve_forever,daemon=True).start()
data=b'\x69'*block;checksum=hashlib.sha256(data).hexdigest();uid=str(uuid.uuid4())
ticket={'v':1,'scope':'edge-upload','id':uid,'userId':'isolated-benchmark','clientIp':'192.0.2.42','size':size,'blockBytes':block,'expiresAt':int(time.time()*1000)+3600000}
payload=base64.urlsafe_b64encode(json.dumps(ticket).encode()).rstrip(b'=');signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),b'edge-upload-v1.'+payload,hashlib.sha256).digest()).rstrip(b'=');token=(payload+b'.'+signature).decode()
remote_offset=0;remote_receipt=None;remote_file=open(root/'fake-a8','w+b');worker=None;connection=None
# Simulate A8 durable commits over a deliberately slower backend. No A8 network calls.
def a8_request(method,path,body=b'',headers=None):
 global remote_offset,remote_receipt
 if path.endswith('/chunk'):
  assert int(headers['Upload-Offset'])==remote_offset
  assert hashlib.sha256(body).hexdigest()==headers['Upload-Checksum']
  time.sleep(len(body)/(args.backend_mibps*block))
  remote_file.seek(remote_offset);remote_file.write(body);remote_file.flush();os.fsync(remote_file.fileno())
  remote_receipt={'start':remote_offset,'length':len(body),'hash':headers['Upload-Checksum']}
  remote_offset+=len(body)
  return {'offset':remote_offset}
 assert method=='GET' and path.endswith(uid),(method,path)
 return {'done':False,'size':size,'offset':remote_offset,'receipt':remote_receipt}
m.a8_request=a8_request

def exact(n):
 result=bytearray()
 while len(result)<n:
  part=connection.recv(n-len(result))
  if not part:raise EOFError('incomplete socket')
  result.extend(part)
 return bytes(result)
def frame_read():
 first,second=exact(2);length=second&127
 if length==126:length=struct.unpack('!H',exact(2))[0]
 elif length==127:length=struct.unpack('!Q',exact(8))[0]
 assert first&15==1 and not second&128
 return json.loads(exact(length))
def frame_write(payload):
 mask=secrets.token_bytes(4);length=len(payload)
 encoded=(int.from_bytes(payload,'little')^int.from_bytes((mask*((length+3)//4))[:length],'little')).to_bytes(length,'little')
 header=b'\x82'+(bytes([0x80|length]) if length<126 else b'\xfe'+struct.pack('!H',length) if length<65536 else b'\xff'+struct.pack('!Q',length))
 connection.sendall(header+mask+encoded)
try:
 assert shutil.disk_usage(root).free>size*2+1024**3
 m.reserve_spool(ticket)
 worker=threading.Thread(target=m.replication_loop,daemon=True);worker.start()
 connection=socket.create_connection(('127.0.0.1',port),30);connection.settimeout(30)
 connection.sendall(m.PROXY_V2_SIGNATURE+b'\x21\x11\x00\x0c'+socket.inet_aton('192.0.2.42')+socket.inet_aton('127.0.0.1')+struct.pack('!HH',50000,port))
 wskey=base64.b64encode(secrets.token_bytes(16)).decode()
 connection.sendall((f'GET /edge-upload/{uid}/stream HTTP/1.1\r\nHost: share.pexserver.com\r\nOrigin: https://share.pexserver.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: {wskey}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: fileshare-upload-v2, {token}\r\n\r\n').encode())
 header=b''
 while not header.endswith(b'\r\n\r\n'):header+=exact(1)
 assert header.startswith(b'HTTP/1.1 101'),header
 assert frame_read()['type']=='ready'
 started=time.monotonic()
 for batch in range(0,size,16*block):
  offsets=list(range(batch,min(size,batch+16*block),block))
  for offset in offsets:
   payload=struct.pack('!IB3xQII',0x46535531,0,offset,block,block)+bytes.fromhex(checksum)+data
   frame_write(payload)
  for offset in offsets:
   ack=frame_read();assert ack['type']=='ack' and ack['offset']==offset+block,ack
  if (batch+len(offsets)*block)%(128*block)==0:print('A1 MiB',(batch+len(offsets)*block)//block,'A8 MiB',round(remote_offset/block,1),'seconds',round(time.monotonic()-started,2),flush=True)
 assert frame_read()['type']=='done'
 elapsed=time.monotonic()-started;state=m.status_for(uid)
 assert state['receivedBytes']==size and state['offset']==size
 assert remote_offset<size,'benchmark too small/slow to demonstrate independent ingress'
 at_ingress=state['replicatedOffset']
 m._stop_event.set();worker.join(30);assert not worker.is_alive()
 state=m.status_for(uid);released=state['releasedOffset']
 digest=hashlib.sha256();remote_file.seek(0);remaining=released
 while remaining:
  part=remote_file.read(min(block,remaining));assert part;digest.update(part);remaining-=len(part)
 with open(root/'a1'/(uid+'.part'),'rb') as pending:
  pending.seek(released)
  while True:
   part=pending.read(block)
   if not part:break
   digest.update(part)
 expected=hashlib.sha256()
 for _ in range(args.mib):expected.update(data)
 assert digest.digest()==expected.digest(),'reconstructed content differs'
 print(json.dumps({'result':'PASS','receivedMiB':args.mib,'ingressMiBps':round(args.mib/elapsed,2),'elapsedSeconds':round(elapsed,2),'backendLimitMiBps':args.backend_mibps,'a8MiBAtIngressCompletion':round(at_ingress/block,1),'sha256Matches':True}),flush=True)
finally:
 m._stop_event.set()
 if worker:worker.join(30)
 if connection:connection.close()
 server.shutdown();remote_file.close();shutil.rmtree(root)
