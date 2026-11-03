from app.services.synthetic import N_ORDERS, N_ORPHANS, PLANTED, generate


def test_generation_is_deterministic():
    assert generate(1) == generate(1)


def test_different_seed_gives_different_data():
    assert generate(1)["orders"] != generate(2)["orders"]


def test_order_count_and_unique_refs():
    orders = generate(7)["orders"]
    assert len(orders) == N_ORDERS
    assert len({o["order_ref"] for o in orders}) == N_ORDERS


def test_planted_counts_match_configuration():
    planted = generate(7)["answer_key"]["planted_exceptions"]
    counts = {}
    for e in planted:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    expected = dict(PLANTED)
    expected["orphan_bank_credit"] = N_ORPHANS
    assert counts == expected


def test_no_order_carries_two_planted_errors():
    planted = generate(7)["answer_key"]["planted_exceptions"]
    refs = [e["order_ref"] for e in planted if e["order_ref"]]
    assert len(refs) == len(set(refs))


def test_money_is_integer_kobo():
    data = generate(7)
    assert all(isinstance(o["amount_kobo"], int) for o in data["orders"])
    for s in data["settlements"]:
        assert all(isinstance(s[k], int) for k in ("gross_kobo", "fee_kobo", "net_kobo"))
    assert all(isinstance(b["amount_kobo"], int) for b in data["bank"])


def test_every_bank_batch_equals_sum_of_settlement_net():
    data = generate(7)
    totals = {}
    for s in data["settlements"]:
        totals[s["batch_id"]] = totals.get(s["batch_id"], 0) + s["net_kobo"]
    bank_by_batch = {b["batch_id"]: b["amount_kobo"] for b in data["bank"] if b["batch_id"]}
    assert totals == bank_by_batch
