"""One-shot, stdlib-only synthetic probe. No paths or execution requests on wire."""
import hashlib
import json
import re
import sys

FRAME_LIMIT = 65536
SOURCE_LIMIT = 8192
QUERY_LIMIT = 256
FIXTURE_ID = "oks-01a-note"
FIXTURE_DIGEST = "30e43a740cf91aaa7873fb97e6527e773d729ec21c5e7770decbce1695f9a360"
ERROR_CODES = ("INVALID_REQUEST", "UNSUPPORTED_VERSION", "UNSUPPORTED_METHOD", "FIXTURE_REJECTED")


def exact(value, names):
    return type(value) is dict and set(value) == set(names)


def utf8(value, maximum, nonempty=False):
    if type(value) is not str or len(value) > maximum or (nonempty and not value):
        return False
    try:
        return len(value.encode("utf-8")) <= maximum
    except UnicodeEncodeError:
        return False


def request_id(value):
    return type(value) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) is not None


def digest(value):
    return type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def is_request(value):
    if not exact(value, ("version", "id", "method", "source", "query")):
        return False
    source = value["source"]
    return (type(value["version"]) is int and value["version"] == 1
            and request_id(value["id"]) and value["method"] == "probe"
            and exact(source, ("id", "digest", "text")) and source["id"] == FIXTURE_ID
            and digest(source["digest"]) and utf8(source["text"], SOURCE_LIMIT)
            and utf8(value["query"], QUERY_LIMIT, True))


def is_response(value):
    if type(value) is not dict or type(value.get("version")) is not int or value["version"] != 1:
        return False
    if value.get("ok") is False:
        return (exact(value, ("version", "id", "ok", "error"))
                and (value["id"] is None or request_id(value["id"]))
                and exact(value["error"], ("code",)) and value["error"]["code"] in ERROR_CODES)
    if value.get("ok") is not True or not exact(value, ("version", "id", "ok", "evidence")) or not request_id(value["id"]):
        return False
    evidence = value["evidence"]
    return evidence is None or (exact(evidence, ("sourceId", "digest", "line", "excerpt"))
        and evidence["sourceId"] == FIXTURE_ID and digest(evidence["digest"])
        and type(evidence["line"]) is int and 1 <= evidence["line"] <= SOURCE_LIMIT + 1
        and utf8(evidence["excerpt"], SOURCE_LIMIT) and not re.search(r"[\r\n]", evidence["excerpt"]))


def error(code, identity=None):
    return {"version": 1, "id": identity, "ok": False, "error": {"code": code}}


def handle(value):
    identity = value.get("id") if type(value) is dict and request_id(value.get("id")) else None
    if type(value) is dict and value.get("version") != 1:
        return error("UNSUPPORTED_VERSION", identity)
    if type(value) is dict and value.get("method") != "probe":
        return error("UNSUPPORTED_METHOD", identity)
    if not is_request(value):
        return error("INVALID_REQUEST", identity)
    source = value["source"]
    if source["digest"] != FIXTURE_DIGEST or hashlib.sha256(source["text"].encode("utf-8")).hexdigest() != FIXTURE_DIGEST:
        return error("FIXTURE_REJECTED", identity)
    evidence = None
    for number, line in enumerate(re.split(r"\r\n|\n|\r", source["text"]), 1):
        if value["query"] in line:
            evidence = {"sourceId": FIXTURE_ID, "digest": FIXTURE_DIGEST, "line": number, "excerpt": line}
            break
    return {"version": 1, "id": identity, "ok": True, "evidence": evidence}


def read_frame(stream):
    # One bounded allocation, then at most one byte to reject trailing output.
    data = stream.readline(FRAME_LIMIT + 1)
    if len(data) > FRAME_LIMIT or not data.endswith(b"\n") or stream.read(1):
        raise ValueError("INVALID_FRAME")
    return json.loads(data.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


def main():
    try:
        response = handle(read_frame(sys.stdin.buffer))
    except (ValueError, UnicodeError, RecursionError):
        response = error("INVALID_REQUEST")
    assert is_response(response)
    encoded = (json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    assert len(encoded) <= FRAME_LIMIT
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
