"""Email bodies (plain text + simple HTML). Kept short and honest."""
from html import escape

FOOT_TXT = "\n\n--\nTuneSummary · free, open source listening stats · not affiliated with Spotify\n"


def _html(body, foot):
    return f"""<!doctype html><html><body style="margin:0;background:#F1EEE6;padding:24px;font-family:'IBM Plex Sans',Helvetica,Arial,sans-serif;color:#151513">
<div style="max-width:560px;margin:0 auto;background:#F1EEE6;border-top:2px solid #151513;padding:20px 0">
<div style="font-family:'IBM Plex Mono',Menlo,monospace;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7A776D">
<span style="color:#C2410C">&#9632;</span> TuneSummary</div>
{body}
<p style="font-family:'IBM Plex Mono',Menlo,monospace;font-size:11px;color:#7A776D;border-top:1px solid #ccc8bc;padding-top:12px;margin-top:28px">{foot}</p>
</div></body></html>"""


def _button(url, label):
    return (f'<p style="margin:24px 0"><a href="{escape(url)}" style="background:#151513;color:#F1EEE6;text-decoration:none;'
            f'padding:12px 20px;font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:13px;letter-spacing:.06em;'
            f'text-transform:uppercase;border-radius:2px">{escape(label)} &rarr;</a></p>')


def login(url, minutes):
    text = (f"Here is your sign-in link for TuneSummary:\n\n{url}\n\n"
            f"It works once and expires in {minutes} minutes. If you didn't ask for it, ignore this email; "
            "nothing happens without a click." + FOOT_TXT)
    html = _html(f"""<h1 style="font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:34px;margin:16px 0 8px">Sign in</h1>
<p>Click to sign in to TuneSummary. The link works once and expires in {minutes} minutes.</p>
{_button(url, "Sign in")}
<p style="font-size:13px;color:#4A4943">Or paste this into your browser:<br><span style="word-break:break-all">{escape(url)}</span></p>
<p style="font-size:13px;color:#4A4943">If you didn't ask for this, ignore it; nothing happens without a click.</p>""",
                 "TuneSummary · free, open source listening stats · not affiliated with Spotify")
    return "Your TuneSummary sign-in link", text, html


def reminder(upload_url, guide_url, unsub_url, second=False):
    lead = ("A week ago we said your Spotify data export was probably ready. If it still hasn't arrived, it can take up to 30 days."
            if second else
            "A few days ago you asked Spotify for your extended streaming history. It has probably arrived by now.")
    steps = ("1. Look for an email from Spotify titled something like \"Your Spotify data is ready to download\".\n"
             "2. Download the zip (my_spotify_data.zip). The link in that email expires after 14 days.\n"
             "3. Upload it here: " + upload_url + "\n")
    text = (f"{lead}\n\n{steps}\nNo email from Spotify yet? Check spam, or see the guide: {guide_url}\n\n"
            f"Stop these reminders: {unsub_url}" + FOOT_TXT)
    html = _html(f"""<h1 style="font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:34px;margin:16px 0 8px">Your data should be <em>ready</em></h1>
<p>{escape(lead)}</p>
<ol style="padding-left:20px;line-height:1.7">
<li>Look for an email from Spotify titled something like <b>"Your Spotify data is ready to download"</b>.</li>
<li>Download the zip (<code>my_spotify_data.zip</code>). The link in that email expires after 14 days.</li>
<li>Upload it to TuneSummary. It's read in your browser and only the play list is sent.</li></ol>
{_button(upload_url, "Upload my data")}
<p style="font-size:13px;color:#4A4943">No email from Spotify yet? Check spam, or <a href="{escape(guide_url)}" style="color:#151513">read the guide</a>.</p>""",
                 f'You get this because you asked for a reminder. <a href="{escape(unsub_url)}" style="color:#7A776D">Stop reminders</a>.'
                 " · TuneSummary is not affiliated with Spotify.")
    subj = "Still waiting on your Spotify data?" if second else "Your Spotify data should be ready: here's how to upload it"
    return subj, text, html
