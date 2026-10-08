import subprocess, os, time
exe=r'C:/Users/GG/WorkBuddy/2026-10-04-09-08-25/app/dist/DGO Setup 0.1.0.exe'
d='D:' + chr(92) + 'DGO'
p=subprocess.Popen([exe,'/S','/D='+d], cwd=os.path.dirname(exe))
p.wait(timeout=150)
print('installer exit:', p.returncode)
a=d + chr(92) + 'resources' + chr(92) + 'app.asar'
print('asar:', os.path.getsize(a) if os.path.exists(a) else 'MISSING', '|', time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(a))) if os.path.exists(a) else '')
