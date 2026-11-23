# Saves ONLY the smile.one cookies (no Google cookies) from the debug Chrome (port 9222)
# into smileone_session.json. Normally you run it through get_session.bat.
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://localhost:9222")
    ctx = browser.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    ua = page.evaluate("navigator.userAgent")
    state = ctx.storage_state()
    state["cookies"] = [c for c in state["cookies"]
                        if "smile.one" in (c.get("domain") or "")]
    state["origins"] = []
    state["user_agent"] = ua
    json.dump(state, open("smileone_session.json", "w", encoding="utf-8"))
    names = {c["name"] for c in state["cookies"]}
    print("saved", len(state["cookies"]), "smile.one cookies")
    if "PHPSESSID" not in names:
        print("WARNING: PHPSESSID not found - are you logged in to smile.one in this Chrome window?")
    browser.close()
