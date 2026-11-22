# Synthetic protocol v1

`request.schema.json` and `response.schema.json` define exact shapes; additional fields are forbidden. The hand-written TypeScript and Python validators both exercise `fixtures/cases.json`. JSON Schema character limits are supplemented by runtime UTF-8 byte limits and rejection of unpaired surrogates. Frames are one UTF-8 JSON object followed by LF, maximum 65536 bytes including LF. One request and EOF; one response and process exit. Malformed, unsupported, oversized or extra input yields a typed error. The supervisor rejects extra output, nonzero exit and unmatched IDs.

The engine accepts no filesystem path. It independently pins source ID and digest and checks actual text bytes. Queries are literal case-sensitive substrings; the desktop command fixes `MATCH-01:`. Tests also use EN, RU and absent queries. The first matching line wins, with CR/LF/CRLF delimiters excluded, a 1-based locator and whole-source digest. No match returns null evidence. Source fixtures were independently authored for this repository and contain no real vault data. The plugin verifies evidence against its request before display.

CLI automation using the same entry point (run from repository root):

```sh
python3 -c 'import json; print(json.dumps(json.load(open("contracts/fixtures/cases.json"))[0]["value"]))' | python3 -I -B engine/probe.py
```

No Obsidian CLI or external-agent interface is claimed.
