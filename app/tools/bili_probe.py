"""bili-probe: B站UP主动态列表探针（只读列表，不下载）。
用法: bili-probe.exe <UID> [cookies.txt] [pages]
输出(JSON stdout): {"code":0,"items":[{"id","type":"video|opus|text","title"}]}
带 wbi 签名（yt-dlp 同款算法）+ 每次刷新游客指纹，下载一律交给官方引擎。
pages=翻页数（默认2）：登录态下充电专属图文会占据动态列表前排，多翻页才能看到穿插其中的投稿视频。
"""
import sys, json, urllib.request, urllib.parse, hashlib, time

# Windows 控制台/管道默认 GBK，emoji 会炸编码——强制 UTF-8
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
             33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
             61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
             36, 20, 34, 44, 52]


def http_json(url, headers):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return json.load(r)


def get_mixin_key():
    """nav 接口拿 wbi key（无需登录），计算 mixin key"""
    j = http_json('https://api.bilibili.com/x/web-interface/nav',
                  {'User-Agent': UA, 'Referer': 'https://www.bilibili.com/'})
    wbi = (j.get('data') or {}).get('wbi_img') or {}
    img = (wbi.get('img_url') or '').rsplit('/', 1)[-1].split('.')[0]
    sub = (wbi.get('sub_url') or '').rsplit('/', 1)[-1].split('.')[0]
    raw = img + sub
    return ''.join(raw[i] for i in MIXIN_TAB if i < len(raw))[:32]


def wbi_sign(params, mixin_key):
    """对参数做 wbi 签名，返回含 w_rid/wts 的完整参数"""
    params = dict(params)
    params['wts'] = int(time.time())
    items = sorted(params.items())
    query = urllib.parse.urlencode(items)
    w_rid = hashlib.md5((query + mixin_key).encode()).hexdigest()
    params['w_rid'] = w_rid
    return params


def cookie_header(path):
    pairs = []
    try:
        for line in open(path, encoding='utf-8'):
            p = line.rstrip('\n').split('\t')
            if len(p) >= 7 and 'bilibili' in p[0]:
                pairs.append(f'{p[5]}={p[6]}')
    except OSError:
        pass
    return '; '.join(pairs)


def refresh_guest_cookie():
    """每次运行刷新游客指纹（spi 派发新 buvid——游客浏览的正常行为，风控盯的是单指纹频率）"""
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request('https://api.bilibili.com/x/frontend/finger/spi', headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    with op.open(req, timeout=15) as r:
        j = json.load(r)
    d = j.get('data') or {}
    return {'buvid3': d.get('b_3', ''), 'buvid4': d.get('b_4', ''), 'b_nut': d.get('b_nut', '')}


def parse_items(data):
    """从 feed/space 的 data 里解析动态条目（含新版 draw.items[].src 图片结构）"""
    items = []
    for it in (data or {}).get('items') or []:
        dyn = (it.get('modules') or {}).get('module_dynamic') or {}
        major = dyn.get('major') or {}
        archive = major.get('archive')
        if archive and archive.get('bvid'):
            items.append({"id": archive['bvid'], "type": "video", "title": archive.get('title', '')})
            continue
        # 图文/图片动态：只有带图片的才值得下载；纯文字动态无媒体，标记 text
        opus = major.get('opus') or {}
        draw = major.get('draw') or {}
        pics = opus.get('pictures') or draw.get('pictures') or []
        if not pics:
            # 新版 API：图片在 draw.items[]（每项带 src 的节点）——漏识别会把图文误判成纯文字
            pics = [n for n in (draw.get('items') or []) if (n or {}).get('src')]
        if pics:
            desc = ''
            for n in (dyn.get('richtext') or {}).get('nodes') or []:
                if n.get('type') == 'RICH_TEXT_NODE_TYPE_TEXT':
                    desc = (n.get('text') or '')[:30]
                    break
            items.append({"id": it.get('id_str'), "type": "opus", "title": desc, "pics": len(pics)})
        else:
            items.append({"id": it.get('id_str'), "type": "text", "title": ''})
    return items


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"code": -1, "msg": "usage: bili-probe <UID> [cookies.txt] [pages]"}))
        return 2
    uid = sys.argv[1]
    cookie = cookie_header(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] != '-' else ''
    try:
        # pages: 数字=翻 N 页；'all'=全量（一直翻到没有更多）
        pages = sys.argv[3] if len(sys.argv) > 3 else '2'
        pages = 'all' if str(pages).lower() == 'all' else max(1, min(6, int(pages)))
    except ValueError:
        pages = 2
    # 合并新派发的游客指纹（新值覆盖旧值）
    try:
        fresh = refresh_guest_cookie()
        parts = [p for p in cookie.split('; ') if p] if cookie else []
        have = {p.split('=')[0]: p for p in parts}
        for k, v in fresh.items():
            if v:
                have[k] = f'{k}={v}'
        cookie = '; '.join(have.values())
    except Exception:
        pass  # 指纹刷新失败就用存量 cookie

    headers = {
        'User-Agent': UA,
        'Referer': f'https://space.bilibili.com/{uid}/',
    }
    if cookie:
        headers['Cookie'] = cookie

    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def fetch_feed(extra_params):
        """请求一页动态（-352 间歇性风控：等 45-90s 换新指纹重试，最多 4 次）"""
        try:
            mixin = get_mixin_key()
            signed = wbi_sign(dict({'host_mid': uid}, **extra_params), mixin)
            url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?' + urllib.parse.urlencode(signed)
        except Exception:
            # wbi 失败降级为裸请求
            q = dict({'host_mid': uid}, **extra_params)
            url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?' + urllib.parse.urlencode(q)
        for attempt in range(4):
            try:
                with op.open(urllib.request.Request(url, headers=headers), timeout=20) as r:
                    j = json.load(r)
            except Exception as e:
                print(json.dumps({"code": -1, "msg": f"request failed: {e}"}, ensure_ascii=False))
                sys.exit(1)
            if j.get('code') == 0:
                return j.get('data') or {}
            if j.get('code') == -352 and attempt < 3:
                time.sleep(45 + attempt * 15)
                try:
                    fresh = refresh_guest_cookie()   # 每次重试换新指纹
                    cur = headers.get('Cookie', '') or cookie
                    have = {p.split('=')[0]: p for p in cur.split('; ') if p}
                    for k, v in fresh.items():
                        if v:
                            have[k] = f'{k}={v}'
                    headers['Cookie'] = '; '.join(have.values())
                except Exception:
                    pass
                continue
            print(json.dumps({"code": j.get('code'), "msg": j.get('message', '')}, ensure_ascii=False))
            sys.exit(1)
        return {}

    items = []
    offset = ''
    page = 0
    while True:
        page += 1
        params = {'offset': offset} if offset else {}
        data = fetch_feed(params)
        items.extend(parse_items(data))
        if not data.get('has_more'):
            break
        offset = data.get('offset') or ''
        if not offset:
            break
        if pages != 'all' and page >= pages:
            break
        time.sleep(1.5)   # 翻页间隔，防触发频率风控
    print(json.dumps({"code": 0, "items": items}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
