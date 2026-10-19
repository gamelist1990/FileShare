import importlib.util,threading,sys,os
spec=importlib.util.spec_from_file_location('spool',os.path.join(os.path.dirname(__file__),'../deploy/a1-edge-spool.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.init_db()
server=m.EdgeHTTPServer((m.BIND_HOST,m.BIND_PORT),m.EdgeHandler)
threading.Thread(target=server.serve_forever,daemon=True).start()
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
    elif line.strip()=='stop':break
server.shutdown()
