"""Insights: every rule on a small household, guards, ranking, the five-item limit, wording."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)
from cents.services import insights, ledger, summary
from cents.services.text import euro

E = "€ "


def candidates(book, period=None):
    lg = ledger.build(book.conn)
    p = lg.period(period) if period else lg.current()
    ov = summary.build_overview(book.conn, lg, p)
    return {i["kind"]: i for i in insights.candidates(book.conn, lg, p, ov)}, ov


def household(book):
    """Oct 2025 - Feb 2026 complete, today 15 March 2026."""
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    book.tx(sav, "2026-01-01", 100, "sparen", "Rente", method="interest", balance=100000)
    book.tx(chk, "2024-03-28", -9450, "vervoer", "ANWB", method="debit")
    book.tx(chk, "2025-03-28", -9450, "vervoer", "ANWB", method="debit")
    book.tx(chk, "2025-02-10", -20000, "boodschappen", "Jumbo", method="card")
    months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]
    for m in months:
        book.tx(chk, f"{m}-25", 300000, "salaris", "Werkgever")
        book.tx(chk, f"{m}-26", -50000, "sparen", "Spaar", kind="transfer", to=sav)
        for d in ("05", "12", "19", "26"):
            book.tx(chk, f"{m}-{d}", -10000, "boodschappen", "Jumbo", method="card")
    for m in months + ["2026-03"]:
        book.tx(chk, f"{m}-01", -100000, "wonen", "Verhuurder", method="debit")
    for m, amount in zip(months + ["2026-03"], [-1399] * 3 + [-1599] * 3):
        book.tx(chk, f"{m}-09", amount, "abonnementen", "Netflix", method="card")
    for m in ("2026-01", "2026-02", "2026-03"):
        book.tx(chk, f"{m}-03", -1099, "abonnementen", "Disney+", method="card")
    for m in ("2025-07", "2025-08", "2025-09", "2025-10", "2025-11"):
        book.tx(chk, f"{m}-14", -1299, "abonnementen", "Spotify", method="card")
    for m in ("2025-10", "2025-11", "2025-12"):
        book.tx(chk, f"{m}-20", -3000, "winkelen", "Hema", method="card")
    book.tx(chk, "2026-02-11", -84900, "winkelen", "Coolblue", method="ideal")
    book.tx(chk, "2026-03-05", -30000, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-03-10", -4718, "boodschappen", "Albert Heijn", method="card")
    book.tx(chk, "2026-03-10", -4718, "boodschappen", "Albert Heijn", method="card")
    book.tx(chk, "2026-03-12", -30000, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-03-12", -2500, "unsorted", "Kiosk", method="card")
    book.commit()
    return chk, sav


def test_current_period_rules(client, book):
    household(book)
    found, ov = candidates(book)
    assert found["duplicate"]["title"] == f"Twee keer {E}47 bij Albert Heijn op 10 maart"
    assert found["duplicate"]["tone"] == "warn"
    assert found["price_change"]["title"] == f"Netflix is {E}2 duurder geworden"
    assert found["price_change"]["link"] == {"screen": "recurring", "params": {"key": "netflix|out|monthly|14"}}
    assert found["price_change"]["href"] == "/vaste-lasten"
    assert found["new_recurring"]["title"] == f"Nieuw abonnement: Disney+, {E}11 per maand"
    assert found["ended_recurring"]["title"] == "Spotify is sinds november niet meer betaald"
    assert found["yearly_bill"]["title"] == f"ANWB {E}95 komt eraan in maart"
    spike = found["category_spike"]
    # up to day 12 (data until 12 March + 3 days = day 15): 2 x 10000 normally, 60000 + 9436 now
    assert spike["value_cents"] == 69436 - 20000
    assert spike["title"] == f"Boodschappen: {euro(49436)} meer dan normaal deze maand"
    assert spike["link"] == {"screen": "category", "params": {"id": book.cats["boodschappen"],
                                                              "period": "2026-03"}}
    assert spike["href"] == f"/overzicht/bakje/{book.cats['boodschappen']}?period=2026-03"
    assert found["pace"]["title"].startswith(E) and "meer uitgegeven dan normaal" in found["pace"]["title"]
    assert found["unsorted"]["title"] == "1 winkel zonder bakje"
    assert found["buffer"]["tone"] == "warn" and found["buffer"]["title"].startswith("Je spaargeld dekt 0,")
    assert "stale" not in found and "left_over" not in found      # day 15: too late for last month
    # the API returns the five best, best first, without the internal score
    api = client.get("/api/overview").json()["insights"]
    assert [i["kind"] for i in api] == ["duplicate", "price_change", "ended_recurring",
                                        "new_recurring", "category_spike"]
    assert all("_score" not in i for i in api)
    for i in api:
        assert set(i) >= {"id", "kind", "tone", "emoji", "title", "link", "href"}
        assert "gemiddeld" not in i["title"]


def test_past_period_rules(client, book):
    household(book)
    found, ov = candidates(book, "2026-02")
    net = 300000 - 101599 - 1099 - (40000 + 84900) - 50000
    assert ov["net_cents"] == net
    assert found["left_over"]["title"] == f"{euro(net)} over in februari. Zet het in een potje?"
    assert found["large"]["title"] == f"Eenmalig {E}849 bij Coolblue"
    assert found["savings_rate"]["title"] == "In februari 17 % van je inkomen gespaard"
    assert found["fixed_share"]["title"] == "Je vaste lasten zijn 34 % van je inkomen"
    assert found["fixed_share"]["tone"] == "info"
    assert found["last_year"]["title"] == f"{E}1.049 meer uitgegeven dan in februari vorig jaar"
    for kind in ("pace", "price_change", "unsorted", "stale", "new_recurring", "buffer"):
        assert kind not in found


def test_stale_and_left_over_early_in_period(client, book, today):
    chk, _ = household(book)
    book.tx(chk, "2026-03-25", 300000, "salaris", "Werkgever")
    book.commit()
    today("2026-04-06")
    found, _ = candidates(book)
    assert found["stale"]["title"] == "Laatste import 12 dagen geleden"
    assert found["stale"]["link"] == {"screen": "import", "params": {}}
    net = 300000 - 100000 - 1599 - 1099 - (60000 + 9436 + 2500)
    assert found["left_over"]["title"] == f"{euro(net)} over in maart. Zet het in een potje?"


def test_goal_behind(client, book):
    household(book)
    g = client.post("/api/goals", json={"name": "Fiets", "emoji": "🚲", "target_cents": 120000,
                                        "target_date": "2026-06-01"}).json()
    client.post(f"/api/goals/{g['id']}/entries", json={"amount_cents": 1000, "date": "2026-01-10"})
    found, _ = candidates(book)
    assert found["goal_behind"]["title"] == f"Fiets loopt achter. Met {E}400 per maand haal je het nog"
    assert found["goal_behind"]["link"] == {"screen": "goal", "params": {"id": g["id"]}}


def test_guards_without_history(client, book):
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-03-02", -40000, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-03-03", -90000, "winkelen", "Coolblue", method="ideal")
    book.commit()
    found, _ = candidates(book)
    assert set(found) == {"stale"}    # one month of data: nothing to compare with


def test_euro_format():
    assert euro(8549) == f"{E}85" and euro(-8550) == f"{E}86" and euro(123456789) == f"{E}1.234.568"
