#!/usr/bin/env python3
import datetime,hashlib,json,pathlib,runpy,subprocess,tempfile,time,uuid
ns=runpy.run_path('/usr/local/sbin/pawhub-db-backup');aws=ns['aws'];root=ns['ROOT'];cfg=ns['CONFIG'];run=ns['run']
state=json.loads((root/'state.json').read_text())
assert state['status']=='success'
name='pawhub-restore-check-'+uuid.uuid4().hex[:12]
created=False
try:
    with tempfile.TemporaryDirectory(prefix='restore-',dir=root) as tmp:
        folder=pathlib.Path(tmp);dump=folder/'database.dump'
        args=['s3api','get-object','--bucket',cfg['bucket'],'--key',state['key'],'--version-id',state['version_id'],'/backup/database.dump']
        aws(args,folder)
        with dump.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
        assert digest==state['sha256'],'Downloaded SHA256 mismatch'
        image=subprocess.check_output(['docker','inspect',cfg['db_container'],'--format','{{.Image}}'],text=True).strip()
        run(['docker','run','-d','--name',name,'--network','none','--memory','192m','--cpus','0.5','--shm-size','16m','--tmpfs','/var/lib/postgresql/data:rw,size=128m','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=pawhub','-e','POSTGRES_DB=pawhub',image],stdout=subprocess.DEVNULL)
        created=True
        for i in range(60):
            if subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','pawhub','-d','pawhub'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
            time.sleep(1)
        else:raise RuntimeError('Isolated restore database did not become ready')
        started=time.monotonic()
        with dump.open('rb') as f:
            run(['docker','exec','-i',name,'pg_restore','--exit-on-error','--single-transaction','--no-owner','--no-acl','-U','pawhub','-d','pawhub'],stdin=f,timeout=600)
        sql="SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', schemaname||'.'||tablename, schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename;\n\\gexec\n"
        result=run(['docker','exec','-i',name,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','pawhub','-d','pawhub'],input=sql,text=True,stdout=subprocess.PIPE,timeout=120).stdout
        counts={line.split('|')[0]:int(line.split('|')[1]) for line in result.splitlines() if '|' in line}
        assert counts,'Restored database has no application tables'
        invalid=run(['docker','exec',name,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','pawhub','-d','pawhub','-c',"SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated"],text=True,stdout=subprocess.PIPE).stdout.strip()
        assert invalid=='0','Unvalidated foreign keys after restore'
        report={'verified_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_key':state['key'],'sha256_verified':True,'restore_exit_on_error':True,'network_isolated':True,'application_tables':len(counts),'total_rows':sum(counts.values()),'table_counts':counts,'unvalidated_foreign_keys':int(invalid),'restore_seconds':round(time.monotonic()-started,2)}
        ns['save']('restore-verification.json',report)
        (folder/'restore-verification.json').write_text(json.dumps(report,indent=2))
        aws(['s3','cp','/backup/restore-verification.json','s3://'+cfg['bucket']+'/'+state['key']+'.restore-verification.json','--sse','AES256','--only-show-errors'],folder)
        print(json.dumps({k:v for k,v in report.items() if k!='table_counts'}))
finally:
    if created:
        assert name.startswith('pawhub-restore-check-') and len(name)==33
        run(['docker','rm','-f',name],stdout=subprocess.DEVNULL)
