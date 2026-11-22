# Synthetic protocol v1

`request.schema.json` and `response.schema.json` define exact shapes; additional fields are forbidden. The hand-written TypeScript and Python validators both exercise `fixtures/cases.json` and raw `fixtures/wire-cases.json`. Numeric values use JSON numeric semantics: version 1, 1.0 and 1e0 are equivalent; integral line numbers accept decimal/exponent spellings but never booleans. Duplicate decoded field names (including escaped aliases) are rejected at every object depth. A leading UTF-8 BOM is rejected, while U+FEFF inside a string is preserved. JSON Schema character limits are supplemented by runtime UTF-8 byte limits and rejection of unpaired surrogates. Frames are one UTF-8 JSON object followed by LF, maximum 65536 bytes including LF. One request and EOF; one response and process exit. Malformed, unsupported, oversized or extra input yields a typed error. The supervisor rejects extra output, nonzero exit and unmatched IDs.

The engine accepts no filesystem path. It independently pins source ID and digest and checks actual text bytes. Queries are literal case-sensitive substrings; the desktop command fixes `MATCH-01:`. Tests also use EN, RU and absent queries. The first matching line wins, with CR/LF/CRLF delimiters excluded, a 1-based locator and whole-source digest. No match returns null evidence. Source fixtures were independently authored for this repository and contain no real vault data. The plugin verifies evidence against its request before display.

CLI automation using the same entry point (run from repository root):

```sh
python3 -c 'import json; print(json.dumps(json.load(open("contracts/fixtures/cases.json"))[0]["value"]))' | python3 -I -B engine/probe.py
```

No Obsidian CLI or external-agent interface is claimed.

## Future portable retrieval contract

[Portable data and evidence semantics](portable-model.md) is the ADR-0006 architecture draft shared by the future plugin-native and optional backend implementations. It is **not** the active v1 synthetic-probe wire format. No production search format is frozen yet.
