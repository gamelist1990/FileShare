import importlib.util,threading,sys,os,uuid,time,hashlib
spec=importlib.util.spec_from_file_location('spool',os.path.join(os.path.dirname(__file__),'../deploy/a1-edge-spool.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.init_db()
server=m.EdgeHTTPServer((m.BIND_HOST,m.BIND_PORT),m.EdgeHandler)
threading.Thread(target=server.serve_forever,daemon=True).start()
gate=threading.Event();gate.set()
original_request=m.a8_request
def gated_request(method,path,*args,**kwargs):
    if path.endswith('/chunk') and not gate.is_set():
        print('BLOCKED',flush=True)
        gate.wait()
    return original_request(method,path,*args,**kwargs)
m.a8_request=gated_request
print('READY',flush=True)
for line in sys.stdin:
    if line.strip()=='replicate':
        for _ in range(100):
            progressed=False
            for row in m.active_uploads():progressed=m.replicate_one(row['id']) or progressed
            if not progressed:break
        print('REPLICATED',flush=True)
    elif line.strip()=='step':
        for row in m.active_uploads():m.replicate_one(row['id'])
        print('STEPPED',flush=True)
    elif line.strip()=='hold':
        gate.clear();print('HELD',flush=True)
    elif line.strip()=='release':
        gate.set();print('RELEASED',flush=True)
    elif line.strip()=='background':
        threading.Thread(target=m.replication_loop,daemon=True).start()
        print('BACKGROUND',flush=True)
    elif line.strip()=='verify-isolation':
        upload_id=str(uuid.uuid4());block=b'x'*(1024*1024);checksum=hashlib.sha256(block).hexdigest()
        ticket={'id':upload_id,'userId':'lock-test','clientIp':'192.0.2.42','size':24*len(block),'blockBytes':len(block),'expiresAt':int(time.time()*1000)+3600000}
        m.reserve_spool(ticket)
        for offset in range(0,16*len(block),len(block)):m.accept_block(ticket,offset,block,checksum,'identity')
        m.update_replication(upload_id,16*len(block),'syncing')
        blocked=threading.Event();resume=threading.Event();original_fsync=m.os.fsync
        def slow_fsync(fd):
            if threading.current_thread().name=='slow-reclaim':
                blocked.set();resume.wait(5)
            original_fsync(fd)
        m.os.fsync=slow_fsync
        reclamation=threading.Thread(target=lambda:m.release_confirmed_prefix(upload_id,16*len(block)),name='slow-reclaim')
        reclamation.start()
        try:
            assert blocked.wait(2), 'reclamation did not reach fsync'
            ingress=threading.Thread(target=lambda:m.accept_block(ticket,16*len(block),block,checksum,'identity'))
            ingress.start();ingress.join(1)
            assert not ingress.is_alive(), 'background reclamation blocked durable ingress'
            assert m.status_for(upload_id)['offset']==17*len(block)
            print('ISOLATED',flush=True)
        finally:
            resume.set();reclamation.join(5);m.os.fsync=original_fsync
            m.delete_upload(upload_id)
    elif line.strip()=='stop':
        m._stop_event.set();gate.set();break
server.shutdown()
