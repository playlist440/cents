"""Request bodies. Responses are plain dicts (see services/txquery.py for the Tx shape).

Optional fields use `model_fields_set` in the routes to tell "not sent" from "sent as null".
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from .errors import bad_request

MONEY_LIMIT = 10 ** 12          # ten billion euros: anything beyond is a typo or an attack
Money = Annotated[int, Field(ge=-MONEY_LIMIT, le=MONEY_LIMIT)]
PositiveMoney = Annotated[int, Field(ge=1, le=MONEY_LIMIT)]

AccountType = Literal["checking", "savings", "credit", "investment"]
Group = Literal["income", "fixed", "daily", "saving", "internal"]


def iso_date(text: str | None, field: str = "datum") -> str | None:
    if text is None:
        return None
    try:
        return date.fromisoformat(text).isoformat()
    except (TypeError, ValueError):
        raise bad_request(f"Ongeldige {field}.", "bad_date") from None


class PasswordBody(BaseModel):
    password: str = Field(max_length=1000)


class PasswordChange(BaseModel):
    current: str = Field(max_length=1000)
    new: str = Field(max_length=1000)


class TxPatch(BaseModel):
    category_id: int | None = None
    apply_to_merchant: bool = True
    # "one" | "merchant" | "merchant_below" (wins over apply_to_merchant when given)
    apply_scope: Literal["one", "merchant", "merchant_below"] | None = None
    below_cents: PositiveMoney | None = None
    tag_ids: list[int] | None = None
    tag_always: bool = False
    note: str | None = Field(default=None, max_length=2000)
    goal_id: int | None = None
    # boekdatum: the day the overviews count this payment on ("" or null = its own date)
    book_date: str | None = None
    # uitsmeren: count this payment in equal parts over this many months (null or 1 = at once)
    spread_months: int | None = Field(default=None, ge=1, le=240)
    # manual transactions only
    account_id: int | None = None
    date: str | None = None
    amount_cents: Money | None = None
    merchant_name: str | None = Field(default=None, max_length=200)


class TxCreate(BaseModel):
    account_id: int
    date: str
    amount_cents: Money
    merchant_name: str = Field(min_length=1, max_length=200)
    category_id: int | None = None
    tag_ids: list[int] = []
    note: str | None = Field(default=None, max_length=2000)


class TxBulk(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=5000)
    category_id: int | None = None
    add_tag_ids: list[int] = []
    remove_tag_ids: list[int] = []


class SortBody(BaseModel):
    merchant_key: str = Field(min_length=1)
    category_id: int


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=20)
    grp: Group = "daily"


class CategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=20)
    grp: Group | None = None
    hidden: bool | None = None
    sort: int | None = None


class TagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=20)


class TagPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=20)
    archived: bool | None = None


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    type: AccountType
    iban: str | None = Field(default=None, max_length=40)
    match: list[str] | None = None


class AccountPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    type: AccountType | None = None
    iban: str | None = Field(default=None, max_length=40)
    match: list[str] | None = None
    hidden: bool | None = None
    locked: bool | None = None
    sort: int | None = None
    manual_balance_cents: Money | None = None
    manual_balance_date: str | None = None


class AccountValueBody(BaseModel):
    date: str
    value_cents: Money


class TradeBody(BaseModel):
    date: str
    isin: str = Field(min_length=12, max_length=12)
    name: str | None = Field(default=None, max_length=120)
    side: Literal["buy", "sell"] = "buy"
    quantity: float = Field(gt=0, le=10 ** 9)
    price_cents: PositiveMoney
    fees_cents: int = Field(default=0, ge=0, le=MONEY_LIMIT)


class SecurityPatch(BaseModel):
    price_symbol: str | None = Field(default=None, max_length=30)


class RulePatch(BaseModel):
    category_id: int | None = None
    below_cents: PositiveMoney | None = None          # null clears the threshold
    below_category_id: int | None = None


class SettingsPatch(BaseModel):
    month_start_day: int | None = Field(default=None, ge=1, le=28)
    household_name: str | None = Field(default=None, max_length=80)
    dismissed_suggestions: list[Annotated[str, Field(max_length=200)]] | None = Field(default=None, max_length=200)
    assumptions: dict[str, dict[str, Any]] | None = None


# ---------------------------------------------------------------- analytics

class RecurringIgnoreBody(BaseModel):
    key: str = Field(min_length=1, max_length=300)


class GoalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=20)
    target_cents: PositiveMoney
    target_date: str | None = None
    repeat: Literal["none", "yearly"] = "none"
    keywords: list[str] = Field(default=[], max_length=20)
    code: str | None = Field(default=None, max_length=5)


class GoalPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=20)
    target_cents: PositiveMoney | None = None
    target_date: str | None = None
    repeat: Literal["none", "yearly"] | None = None
    keywords: list[str] | None = Field(default=None, max_length=20)
    code: str | None = Field(default=None, max_length=5)
    archived: bool | None = None
    sort: int | None = None


class GoalEntryBody(BaseModel):
    amount_cents: Money | None = None
    date: str | None = None
    note: str | None = Field(default=None, max_length=500)
    transaction_id: int | None = None


class GoalSaldoBody(BaseModel):
    saldo_cents: Money


class InsightDismissBody(BaseModel):
    id: str = Field(min_length=1, max_length=300)


class InsightMuteBody(BaseModel):
    kind: str = Field(min_length=1, max_length=40)
    muted: bool = True


class GoalLinkBody(BaseModel):
    goal_id: int
    description: str = Field(min_length=1, max_length=500)


class MortgagePartName(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class MortgageCreate(BaseModel):
    parts: list[MortgagePartName] = Field(min_length=1, max_length=8)


class MortgagePatch(BaseModel):
    include_in_networth: bool | None = None
    merchant_key: str | None = None             # null = automatic, "" = no link


class MortgageYearPart(BaseModel):
    part_id: int
    debt_end_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)]
    interest_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] = 0
    repaid_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] = 0
    principal_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] | None = None   # new loan that year


class MortgageYearBody(BaseModel):
    parts: list[MortgageYearPart] = Field(min_length=1, max_length=8)


class HomeValueBody(BaseModel):
    date: str
    value_cents: PositiveMoney


class AssetCreate(BaseModel):
    kind: Literal["pension", "debt", "other", "possession"]
    name: str = Field(min_length=1, max_length=60)
    debt_kind: Literal["studieschuld", "lening", "overig"] | None = None
    include: bool | None = None                 # default: pension off, the others on
    merchant_key: str | None = None             # debt only; absent on a studieschuld = DUO if found
    # possession (bezitting): the purchase payment, or price + date when it is not in Cents
    tx_id: int | None = None
    price_cents: Annotated[int, Field(gt=0, le=MONEY_LIMIT)] | None = None
    start_date: str | None = None
    life_months: Annotated[int, Field(ge=6, le=360)] | None = None
    residual_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] | None = None
    curve: Literal["linear", "front"] | None = None
    category_id: int | None = None
    emoji: str | None = Field(default=None, max_length=16)


class AssetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    debt_kind: Literal["studieschuld", "lening", "overig"] | None = None
    include: bool | None = None
    merchant_key: str | None = None             # debt only; null or "" = no link
    # possession
    price_cents: Annotated[int, Field(gt=0, le=MONEY_LIMIT)] | None = None
    start_date: str | None = None
    life_months: Annotated[int, Field(ge=6, le=360)] | None = None
    residual_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] | None = None
    curve: Literal["linear", "front"] | None = None
    category_id: int | None = None
    emoji: str | None = Field(default=None, max_length=16)
    # sale: the payment that brought the money in, or a date and price (inruil); both null = not sold
    sale_tx_id: int | None = None
    sale_date: str | None = None
    sale_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] | None = None


class AssetEntryBody(BaseModel):
    date: str
    value_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)]
    interest_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] | None = None
    repaid_cents: Annotated[int, Field(ge=0, le=MONEY_LIMIT)] | None = None
    note: str | None = Field(default=None, max_length=200)
