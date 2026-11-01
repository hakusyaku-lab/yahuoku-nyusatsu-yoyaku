"""配布用ZIPを dist/ に作る（GitHub Actions から自動で呼ばれます）。

  YahuokuNyusatsuYoyaku.zip          … Chrome・Edge・Brave など（展開して「展開して読み込み」）
  YahuokuNyusatsuYoyaku-firefox.zip  … Firefox（manifest.json が直下。about:debugging から一時読み込み／AMOに提出可）

手元で試すときは:  python scripts/build_zip.py
"""
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["background.js", "content.js", "content.css", "popup.html", "popup.js", "LICENSE"]
ICONS = sorted(p.name for p in (ROOT / "icons").glob("*.png"))


def firefox_manifest(m: dict) -> dict:
    f = json.loads(json.dumps(m))
    f["background"] = {"scripts": ["background.js"]}
    f["permissions"] = [p for p in f["permissions"] if p != "power"]  # Firefox に無い
    f["browser_specific_settings"] = {
        "gecko": {
            "id": "yahuoku-nyusatsu-yoyaku@hakusyaku-lab",
            "strict_min_version": "140.0",
            "data_collection_permissions": {"required": ["none"]},
        }
    }
    return f


def write(zip_name: str, manifest: dict, folder: str) -> None:
    out = ROOT / "dist" / zip_name
    out.parent.mkdir(exist_ok=True)
    pre = f"{folder}/" if folder else ""
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(pre + "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        for f in FILES:
            z.write(ROOT / f, pre + f)
        for i in ICONS:
            z.write(ROOT / "icons" / i, f"{pre}icons/{i}")
    print("作成:", out.relative_to(ROOT))


def main() -> None:
    m = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    write("YahuokuNyusatsuYoyaku.zip", m, "YahuokuNyusatsuYoyaku")
    write("YahuokuNyusatsuYoyaku-firefox.zip", firefox_manifest(m), "")


if __name__ == "__main__":
    main()
