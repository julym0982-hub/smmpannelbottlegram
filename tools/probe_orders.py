# READ-ONLY probe of Smile One's order list (/customer/order). Buys nothing.
# Shows how the table, the status filter and the paging work, so the bot can
# check an order's status. Emails are masked. Run from the folder that holds smileone_session.json
import json, re, requests
from bs4 import BeautifulSoup

BASE = "https://www.smile.one"
st = json.load(open("smileone_session.json", encoding="utf-8"))
s = requests.Session()
s.headers.update({"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"})
for c in st["cookies"]:
    if "smile.one" in (c.get("domain") or ""):
        s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))

def mask(t):
    return re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "<email>", t)

r = s.get(BASE + "/customer/order", timeout=20)
print("status:", r.status_code, "| length:", len(r.text), "| cloudflare:", "just a moment" in r.text.lower())
soup = BeautifulSoup(r.text, "html.parser")

print("\n=== forms / filters (names only) ===")
for f in soup.find_all("form"):
    print(" form action:", f.get("action"), "| method:", f.get("method"), "| id:", f.get("id"))
for el in soup.find_all(["input", "select"]):
    if el.get("type") == "hidden" and el.get("name") == "_csrf":
        continue
    opts = [(o.get("value"), o.get_text(strip=True)) for o in el.find_all("option")] if el.name == "select" else ""
    print(" ", el.name, "| name:", el.get("name"), "| id:", el.get("id"), "| type:", el.get("type"), "|", opts)

print("\n=== table(s) ===")
for ti, tb in enumerate(soup.find_all("table")):
    heads = [re.sub(r"\s+", " ", th.get_text(" ", strip=True)) for th in tb.find_all("th")]
    print(f" table {ti} headers:", heads)
    rows = tb.find_all("tr")
    print(f" table {ti} rows:", len(rows))
    for tr in rows[1:6]:
        cells = [mask(re.sub(r"\s+", " ", td.get_text(" ", strip=True)))[:45] for td in tr.find_all("td")]
        print("   ", cells)
        for a in tr.find_all("a", href=True)[:2]:
            print("      link:", a["href"][:90])

print("\n=== paging links ===")
seen = set()
for a in soup.select("a[href]"):
    h = a["href"]
    if re.search(r"page|p=|order", h, re.I) and h not in seen:
        seen.add(h); print(" ", a.get_text(strip=True)[:20], "->", h[:100])
        if len(seen) >= 10: break

print("\n=== order-related endpoints in scripts ===")
found = set()
srcs = []
for sc in soup.find_all("script"):
    if sc.get("src"): srcs.append(sc["src"])
    for m in re.findall(r"""["'](/[\w/\-\.]*(?:order|record|history)[\w/\-\.?=&]*)["']""", sc.string or "", re.I):
        found.add(m)
for f in sorted(found): print(" ", f)
for u in srcs:
    if re.search(r"order|customer", u, re.I):
        url = u if u.startswith("http") else BASE + u
        try:
            js = s.get(url, timeout=20).text
            hits = sorted(set(re.findall(r"""["'](/[\w/\-\.]*(?:order|record|history)[\w/\-\.?=&]*)["']""", js, re.I)))
            print(" script", u[:70], "->", hits[:8])
        except Exception as e:
            print(" script", u[:70], "failed:", e)
