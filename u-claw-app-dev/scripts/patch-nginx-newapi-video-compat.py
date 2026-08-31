from datetime import datetime
from pathlib import Path

p = Path("/etc/nginx/sites-available/uclaw-newapi-front.conf")
s = p.read_text()

broken = """    location = /v1/videos/generations {
        proxy_pass http://127.0.0.1:18808;
        proxy_http_version 1.1;
        proxy_set_header Host ;
        proxy_set_header X-Real-IP ;
        proxy_set_header X-Forwarded-For ;
        proxy_set_header X-Forwarded-Proto ;
        proxy_set_header X-UClaw-NewAPI-Compat 1;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location ~ ^/v1/videos/task_[^/]+$ {
        proxy_pass http://127.0.0.1:18808;
        proxy_http_version 1.1;
        proxy_set_header Host ;
        proxy_set_header X-Real-IP ;
        proxy_set_header X-Forwarded-For ;
        proxy_set_header X-Forwarded-Proto ;
        proxy_set_header X-UClaw-NewAPI-Compat 1;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

"""

compat = """    location = /v1/videos/generations {
        proxy_pass http://127.0.0.1:18808;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-UClaw-NewAPI-Compat 1;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location ~ ^/v1/videos/task_[^/]+$ {
        proxy_pass http://127.0.0.1:18808;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-UClaw-NewAPI-Compat 1;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

"""

if broken in s:
    s = s.replace(broken, compat, 1)
elif "X-UClaw-NewAPI-Compat 1" not in s:
    marker = "    location /v1/ {"
    if marker not in s:
        raise SystemExit("marker not found")
    s = s.replace(marker, compat + marker, 1)
else:
    print("already patched")
    raise SystemExit(0)

stamp = datetime.now().strftime("%Y%m%d%H%M%S")
backup = p.with_name(p.name + ".bak." + stamp)
backup.write_text(p.read_text())
p.write_text(s)
print(f"backup:{backup}")
