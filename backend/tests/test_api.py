from collections import Counter

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import create_app
from app.services.pipeline import run_full_pipeline
from app.services.synthetic import generate, write_files

PLANTED = generate(7)["answer_key"]["planted_exceptions"]


@pytest.fixture()
def client(tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, autoflush=False)
    write_files(generate(7), tmp_path)
    with TestSession() as s:
        run_full_pipeline(s, tmp_path)

    def override():
        with TestSession() as session:
            yield session

    app = create_app()
    app.dependency_overrides[get_db] = override
    with TestClient(app) as c:
        yield c


def first_of(client, kind):
    return client.get("/api/exceptions", params={"type": kind, "limit": 1}).json()["items"][0]


def act(client, exception_id, action, actor="tester", note="checked the records"):
    return client.post(
        f"/api/exceptions/{exception_id}/actions",
        json={"action": action, "actor": actor, "note": note},
    )


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_summary_matches_the_pipeline(client):
    s = client.get("/api/summary").json()
    assert s["orders_total"] == 500
    assert s["exceptions_total"] == len(PLANTED) == 44
    assert {k: v["count"] for k, v in s["by_type"].items()} == dict(
        Counter(e["type"] for e in PLANTED)
    )
    assert s["orders_matched"] == s["orders_total"] - s["by_type"]["missing_settlement"]["count"]
    assert s["unresolved_at_risk_kobo"] == sum(e["amount_at_risk_kobo"] for e in PLANTED)
    assert s["by_status"] == {"open": 44, "escalated": 0, "resolved": 0}


def test_list_returns_all_exceptions_with_integer_money(client):
    body = client.get("/api/exceptions", params={"limit": 200}).json()
    assert body["total"] == 44 and len(body["items"]) == 44
    assert all(isinstance(i["amount_at_risk_kobo"], int) for i in body["items"])
    assert all(i["summary"] for i in body["items"])
    risks = [i["amount_at_risk_kobo"] for i in body["items"]]
    assert risks == sorted(risks, reverse=True)


def test_filter_by_type(client):
    body = client.get("/api/exceptions", params={"type": "fee_discrepancy"}).json()
    assert body["total"] == 8
    assert {i["type"] for i in body["items"]} == {"fee_discrepancy"}


@pytest.mark.parametrize(
    "params",
    [{"type": "nonsense"}, {"status": "nonsense"}, {"limit": 0}, {"limit": 500}, {"offset": -1}],
)
def test_invalid_query_is_rejected(client, params):
    assert client.get("/api/exceptions", params=params).status_code == 422


def test_search_by_reference(client):
    target = first_of(client, "missing_settlement")
    body = client.get("/api/exceptions", params={"search": target["order_ref"].lower()}).json()
    assert target["id"] in [i["id"] for i in body["items"]]
    assert client.get("/api/exceptions", params={"search": "zzz-no-such-ref"}).json()["total"] == 0


def test_paging(client):
    everything = [
        i["id"] for i in client.get("/api/exceptions", params={"limit": 200}).json()["items"]
    ]
    page1 = client.get("/api/exceptions", params={"limit": 10, "offset": 0}).json()
    last = client.get("/api/exceptions", params={"limit": 10, "offset": 40}).json()
    assert page1["total"] == 44 and len(page1["items"]) == 10
    assert [i["id"] for i in page1["items"]] == everything[:10]
    assert len(last["items"]) == 4


def test_detail_has_evidence_and_related_records(client):
    item = first_of(client, "fee_discrepancy")
    d = client.get(f"/api/exceptions/{item['id']}").json()
    assert d["evidence"]["fee_charged_kobo"] != d["evidence"]["fee_expected_kobo"]
    assert d["order"]["order_ref"] == item["order_ref"]
    assert d["settlement"]["fee_kobo"] == d["evidence"]["fee_charged_kobo"]
    assert d["bank_transaction"] is not None
    assert d["audit_trail"] == []
    assert d["ai_explanation"] is None

    orphan = first_of(client, "orphan_bank_credit")
    od = client.get(f"/api/exceptions/{orphan['id']}").json()
    assert od["order"] is None and od["settlement"] is None
    assert od["bank_transaction"]["bank_ref"] == orphan["bank_ref"]


def test_unknown_id_is_404(client):
    assert client.get("/api/exceptions/999999").status_code == 404
    assert act(client, 999999, "note").status_code == 404


def test_resolve_then_reopen(client):
    item = first_of(client, "fee_discrepancy")
    r = act(client, item["id"], "resolve", actor="ahmad", note="confirmed with processor")
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "resolved" and d["resolved_at"] is not None
    assert [(a["action"], a["actor"]) for a in d["audit_trail"]] == [("resolve", "ahmad")]

    d = act(client, item["id"], "reopen", note="processor reply was wrong").json()
    assert d["status"] == "open" and d["resolved_at"] is None
    assert [a["action"] for a in d["audit_trail"]] == ["resolve", "reopen"]


def test_cannot_resolve_twice(client):
    item = first_of(client, "fee_discrepancy")
    assert act(client, item["id"], "resolve").status_code == 200
    again = act(client, item["id"], "resolve")
    assert again.status_code == 409
    d = client.get(f"/api/exceptions/{item['id']}").json()
    assert len(d["audit_trail"]) == 1


def test_escalate_then_resolve(client):
    item = first_of(client, "fee_discrepancy")
    assert act(client, item["id"], "escalate").json()["status"] == "escalated"
    assert act(client, item["id"], "escalate").status_code == 409
    assert act(client, item["id"], "resolve").json()["status"] == "resolved"


def test_note_keeps_status_and_is_audited(client):
    item = first_of(client, "fee_discrepancy")
    d = act(client, item["id"], "note", note="called the bank, waiting").json()
    assert d["status"] == "open"
    assert d["audit_trail"][0]["note"] == "called the bank, waiting"


@pytest.mark.parametrize(
    "payload",
    [
        {"action": "resolve", "actor": "ahmad", "note": "ok"},
        {"action": "delete", "actor": "ahmad", "note": "not allowed here"},
        {"action": "resolve", "actor": "   ", "note": "valid note here"},
    ],
)
def test_invalid_action_requests_are_rejected(client, payload):
    item = first_of(client, "fee_discrepancy")
    r = client.post(f"/api/exceptions/{item['id']}/actions", json=payload)
    assert r.status_code == 422
    assert client.get(f"/api/exceptions/{item['id']}").json()["audit_trail"] == []


def test_status_filter_follows_actions(client):
    ids = [
        i["id"]
        for i in client.get("/api/exceptions", params={"type": "timing_break"}).json()["items"]
    ]
    act(client, ids[0], "resolve")
    act(client, ids[1], "escalate")
    counts = {
        s: client.get("/api/exceptions", params={"status": s}).json()["total"]
        for s in ("open", "escalated", "resolved")
    }
    assert counts == {"open": 42, "escalated": 1, "resolved": 1}

    summary = client.get("/api/summary").json()
    assert summary["by_status"] == counts
    resolved = client.get("/api/exceptions", params={"status": "resolved"}).json()["items"][0]
    total = sum(e["amount_at_risk_kobo"] for e in PLANTED)
    assert summary["unresolved_at_risk_kobo"] == total - resolved["amount_at_risk_kobo"]


def test_load_sample_requires_confirmation(client):
    assert client.post("/api/demo/load-sample", json={"confirm": False}).status_code == 400
    assert client.post("/api/demo/load-sample", json={}).status_code == 422
    assert client.get("/api/summary").json()["exceptions_total"] == 44


def test_load_sample_reloads_the_demo_data(client):
    item = first_of(client, "fee_discrepancy")
    act(client, item["id"], "resolve")
    r = client.post("/api/demo/load-sample", json={"confirm": True})
    assert r.status_code == 200
    body = r.json()
    assert body["loaded"] == {"orders": 500, "settlements": 494, "bank_transactions": 35}
    assert body["exceptions_found"] == 44
    assert client.get("/api/summary").json()["by_status"]["resolved"] == 0
