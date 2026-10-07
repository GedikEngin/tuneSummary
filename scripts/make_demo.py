"""Generate the made-up demo account (web/static/demo.json) or a synthetic export zip for testing.
    python scripts/make_demo.py demo            -> web/static/demo.json
    python scripts/make_demo.py zip OUT.zip     -> fake my_spotify_data.zip (extended history format)"""
import json
import math
import random
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

LIB = {  # artist: (genres, [(track, album, length s)])
    "Radiohead": (["alternative rock", "art rock"], [("Weird Fishes/Arpeggi", "In Rainbows", 318), ("Reckoner", "In Rainbows", 290), ("Everything in Its Right Place", "Kid A", 251), ("No Surprises", "OK Computer", 229)]),
    "Tarkan": (["turkish pop"], [("Şımarık", "Ölürüm Sana", 237), ("Dudu", "Dudu", 248), ("Kuzu Kuzu", "Karma", 233)]),
    "Sezen Aksu": (["turkish pop"], [("Gidiyorum", "Deliveren", 264), ("Firuze", "Firuze", 251)]),
    "Daft Punk": (["french house", "electronic"], [("Digital Love", "Discovery", 301), ("Instant Crush", "Random Access Memories", 337), ("Something About Us", "Discovery", 232)]),
    "Kendrick Lamar": (["hip hop", "west coast hip hop"], [("Money Trees", "good kid, m.A.A.d city", 386), ("DNA.", "DAMN.", 185), ("Alright", "To Pimp a Butterfly", 219)]),
    "Frank Ocean": (["r&b", "alternative r&b"], [("Pink + White", "Blonde", 184), ("Nights", "Blonde", 307), ("Thinkin Bout You", "channel ORANGE", 200)]),
    "Phoebe Bridgers": (["indie folk", "indie rock"], [("Motion Sickness", "Stranger in the Alps", 230), ("Kyoto", "Punisher", 184)]),
    "Tame Impala": (["psychedelic rock", "neo-psychedelia"], [("The Less I Know the Better", "Currents", 216), ("Let It Happen", "Currents", 467), ("Borderline", "The Slow Rush", 237)]),
    "Björk": (["art pop", "electronic"], [("Jóga", "Homogenic", 305), ("Hyperballad", "Post", 321)]),
    "Arctic Monkeys": (["indie rock"], [("Do I Wanna Know?", "AM", 272), ("505", "Favourite Worst Nightmare", 253)]),
    "Taylor Swift": (["pop", "country pop"], [("Cruel Summer", "Lover", 178), ("All Too Well", "Red", 329), ("Anti-Hero", "Midnights", 200)]),
    "Fleetwood Mac": (["soft rock"], [("Dreams", "Rumours", 257), ("The Chain", "Rumours", 270)]),
    "Bon Iver": (["indie folk"], [("Holocene", "Bon Iver, Bon Iver", 336), ("Skinny Love", "For Emma, Forever Ago", 238)]),
    "SZA": (["r&b"], [("Snooze", "SOS", 201), ("Good Days", "SOS", 279)]),
    "Massive Attack": (["trip hop"], [("Teardrop", "Mezzanine", 330), ("Angel", "Mezzanine", 379)]),
    "Nujabes": (["jazz hip hop"], [("Aruarian Dance", "Samurai Champloo Music Record", 211), ("Feather", "Modal Soul", 175)]),
    "Barış Manço": (["anatolian rock"], [("Gülpembe", "Sözüm Meclisten Dışarı", 289), ("Dağlar Dağlar", "2023", 301)]),
    "Miles Davis": (["jazz", "cool jazz"], [("So What", "Kind of Blue", 562), ("Blue in Green", "Kind of Blue", 337)]),
    "Beyoncé": (["pop", "r&b"], [("CUFF IT", "RENAISSANCE", 225), ("Halo", "I Am... Sasha Fierce", 261)]),
    "Mac DeMarco": (["indie rock", "slacker rock"], [("Chamber of Reflection", "Salad Days", 231), ("My Kind of Woman", "2", 191)]),
}
SHOWS = [("The Daily", ["Episode on the news", "Another day of news"]), ("Song Exploder", ["Making a song", "Inside a hit"])]


def plays(seed=7, start=None, days=950):
    start = start or (datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days))
    rnd = random.Random(seed)
    arts = list(LIB)
    out = []
    for d in range(days):
        day = start + timedelta(days=d)
        phase = d / days
        if rnd.random() < 0.06:
            continue
        n = int(rnd.gauss(28, 12) * (0.7 + 0.5 * math.sin(d / 40)))
        favs = arts[int(phase * 12):int(phase * 12) + 8] + arts[:3]
        for _ in range(max(0, n)):
            hour = rnd.choice([8, 9, 12, 13, 17, 18, 19, 21, 22, 22, 23, 23, 0, 1])
            t = day + timedelta(hours=hour, minutes=rnd.randrange(60), seconds=rnd.randrange(60))
            if rnd.random() < 0.03:
                show, eps = rnd.choice(SHOWS)
                out.append({"ts": t, "ep": rnd.choice(eps), "show": show, "ms": rnd.randrange(300, 2400) * 1000})
                continue
            a = rnd.choice(favs) if rnd.random() < 0.8 else rnd.choice(arts)
            tr, al, ln = rnd.choice(LIB[a][1])
            sk = rnd.random() < 0.22
            ms = rnd.randrange(2, 30) * 1000 if sk else int(ln * 1000 * rnd.uniform(0.85, 1.0))
            out.append({"ts": t, "ar": a, "tr": tr, "al": al, "ms": ms, "sk": sk, "sh": rnd.random() < 0.4,
                        "pf": rnd.choice(["android", "android", "Windows 10 (10.0.19045; x64)", "web_player linux", "iOS 17.2 (iPhone14,5)"]),
                        "cc": rnd.choice(["US", "US", "US", "TR"])})
    out.sort(key=lambda p: p["ts"])
    return out


def to_export(ps):
    rows = []
    for p in ps:
        rows.append({"ts": p["ts"].strftime("%Y-%m-%dT%H:%M:%SZ"), "platform": p.get("pf", "android"), "ms_played": p["ms"],
                     "conn_country": p.get("cc", "US"), "master_metadata_track_name": p.get("tr"),
                     "master_metadata_album_artist_name": p.get("ar"), "master_metadata_album_album_name": p.get("al"),
                     "spotify_track_uri": None, "episode_name": p.get("ep"), "episode_show_name": p.get("show"),
                     "reason_end": "fwdbtn" if p.get("sk") else "trackdone", "shuffle": bool(p.get("sh")), "skipped": bool(p.get("sk"))})
    return rows


def to_compact(ps):
    T, Ti, E, Ei, P, Pi, C, Ci, rows = [], {}, [], {}, [], {}, [], {}, []

    def idx(lst, ix, key):
        if key not in ix:
            ix[key] = len(lst)
            lst.append(list(key) if isinstance(key, tuple) else key)
        return ix[key]
    for p in ps:
        ti = idx(T, Ti, (p["tr"], p["ar"], p["al"], None)) if p.get("tr") else -1
        ei = -1 if p.get("tr") else idx(E, Ei, (p["ep"], p["show"]))
        pi = idx(P, Pi, p["pf"]) if p.get("pf") else -1
        ci = idx(C, Ci, p["cc"]) if p.get("cc") else -1
        rows.append([int(p["ts"].timestamp() * 1000), p["ms"], ti, ei, pi, ci, 4 | (1 if p.get("sk") else 0) | (2 if p.get("sh") else 0)])
    genres = {a.lower(): [[g, 10 - i] for i, g in enumerate(LIB[a][0])] for a in LIB}
    return {"tracks": T, "episodes": E, "platforms": P, "countries": C, "rows": rows, "genres": genres}


if __name__ == "__main__":
    ps = plays()
    if sys.argv[1:2] == ["zip"]:
        rows = to_export(ps)
        half = len(rows) // 2
        with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("Spotify Extended Streaming History/Streaming_History_Audio_2023-2024_0.json", json.dumps(rows[:half]))
            z.writestr("Spotify Extended Streaming History/Streaming_History_Audio_2024-2025_1.json", json.dumps(rows[half:]))
            z.writestr("Spotify Extended Streaming History/Streaming_History_Video_2023.json", "[]")
        print(sys.argv[2], len(rows), "plays")
    else:
        out = Path(__file__).resolve().parent.parent / "web/static/demo.json"
        out.write_text(json.dumps(to_compact(ps), separators=(",", ":"), ensure_ascii=False))
        print(out, len(ps), "plays", out.stat().st_size // 1024, "KB")
