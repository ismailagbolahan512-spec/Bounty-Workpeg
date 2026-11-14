"""The services page. A business links its Bounty account with a token made
on Bounty, then reads the hospitality requests, quotes and visits it owns.

Bounty is the system of record. This peg only reads, through /api/peg, with
the token's scope (services:read). It keeps no copy of the data and holds
no role of its own. The token lives in a peg-scoped cookie so the connection
survives page switches; the Disconnect button removes it.
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Expanded,
    Spacer, Text, Button, Link, Tag, Input, TextInput, cookie, http, set_title, store, workpeg,
)

from components import EmptyState, ErrorState, LoadingState, AppointmentStatusTag

# MOCK: the page reads hospitality requests from this business's Workpeg table, so it works
# while Workpeg cannot reach Bounty's server. Set MOCK to False for the live connection below.
MOCK = True
MOCK_NS = "bounty-mock-services"

# Bounty's integration surface. Confirm the production host before publishing.
API = "https://bounty-workpeg.onrender.com/api/peg"
TOKEN_COOKIE = "bounty_token"


class ServicesPage(App):
    draft = State("")             # token as typed; cleared once accepted
    token = State("")             # the active token (read from cookie on mount)
    who = State("")               # the Bounty account name it belongs to
    requests = State([])
    appointments = State([])
    connecting = State(False)
    loading = State(False)
    error = State("")
    table = State("")             # mock: the requests table uuid
    samples = State(0)            # mock: how many sample requests have been added

    async def on_mount(self):
        store.page_title = "Hospitality services"
        set_title("Hospitality services")
        if MOCK:
            self.token = "mock"
            self.who = "Demo business"
            await self.load_mock()
            return
        saved = cookie.get(TOKEN_COOKIE)
        if saved != "":
            self.token = saved
            await self.load()

    async def find_or_make(self):
        tables = await workpeg.get_tables(MOCK_NS)
        if len(tables) > 0:
            return tables[0]["uuid"]
        made = await workpeg.create_table({
            "name": "Service requests (mock)",
            "namespace": MOCK_NS,
            "permission": "760",
            "columns": [
                {"id": "title", "name": "Title", "type": "text", "position": 1000, "required": True},
                {"id": "price", "name": "Price", "type": "text", "position": 2000},
                {"id": "currency", "name": "Currency", "type": "text", "position": 3000},
                {"id": "area_label", "name": "Area", "type": "text", "position": 4000},
                {"id": "local_deadline", "name": "Deadline", "type": "text", "position": 5000},
                {"id": "pending_quotes", "name": "Pending quotes", "type": "text", "position": 6000},
            ],
        })
        return made["uuid"]

    async def load_mock(self):
        if self.loading:
            return
        self.loading = True
        self.error = ""
        try:
            self.table = await self.find_or_make()
            rows = await workpeg.get_rows(self.table, limit=100)
            self.requests = [{
                "id": r.get("uuid", r.get("id", "")),
                "title": r["data"].get("title", ""),
                "price": r["data"].get("price", ""),
                "currency": r["data"].get("currency", ""),
                "area_label": r["data"].get("area_label", ""),
                "local_deadline": r["data"].get("local_deadline", ""),
                "pending_quotes": r["data"].get("pending_quotes", "0"),
            } for r in rows]
            self.appointments = []
        except Exception as e:
            self.error = e.message
        self.loading = False

    async def add_sample(self):
        # Mock only: adds one sample hospitality request so the page has something to show.
        if self.table == "":
            return
        samples = [
            ["Deep clean for a 3-bedroom short let", "45000", "NGN", "Lekki", "Fri 20 Nov", "2"],
            ["Chef for a 40-guest dinner", "120000", "NGN", "Victoria Island", "Sat 21 Nov", "4"],
            ["Event setup for a rooftop launch", "300000", "NGN", "Ikoyi", "Thu 26 Nov", "1"],
        ]
        pick = samples[self.samples % len(samples)]
        self.samples = self.samples + 1
        try:
            rows = await workpeg.get_rows(self.table, limit=100)
            await workpeg.add_row(self.table, {
                "data": {
                    "title": pick[0], "price": pick[1], "currency": pick[2],
                    "area_label": pick[3], "local_deadline": pick[4], "pending_quotes": pick[5],
                },
                "position": (len(rows) + 1) * 1000,
            })
            await self.load_mock()
        except Exception as e:
            self.error = e.message

    def set_draft(self, value):
        self.draft = value

    async def connect(self):
        key = self.draft.strip()
        if self.connecting or key == "":
            return
        self.connecting = True
        self.error = ""
        try:
            me = await http.get(f"{API}/me", auth=key)
            scopes = me.get("scopes", [])
            if "services:read" not in scopes:
                self.error = "This token cannot read services. Tick 'services:read' when you generate it on Bounty."
                self.connecting = False
                return
            self.token = key
            self.who = me.get("user", {}).get("name", "")
            cookie.set(TOKEN_COOKIE, key)
            self.draft = ""
            self.connecting = False
            await self.load()
        except Exception as e:
            self.error = e.message
            self.connecting = False

    def disconnect(self):
        if MOCK:
            return
        cookie.set(TOKEN_COOKIE, "")
        self.token = ""
        self.who = ""
        self.requests = []
        self.appointments = []
        self.error = ""

    async def load(self):
        if MOCK:
            await self.load_mock()
            return
        if self.loading or self.token == "":
            return
        self.loading = True
        self.error = ""
        try:
            reqs = await http.get(f"{API}/business/requests", auth=self.token)
            appts = await http.get(f"{API}/business/appointments", auth=self.token)
            self.requests = reqs.get("requests", [])
            self.appointments = appts.get("appointments", [])
            self.loading = False
        except Exception as e:
            self.error = e.message
            self.loading = False
            if e.problem == "unauthorized" or e.problem == "forbidden":
                # The token is no longer good: clear it and ask again.
                cookie.set(TOKEN_COOKIE, "")
                self.token = ""

    async def refresh(self):
        await self.load()

    def build(self):
        if self.token == "":
            return self.connect_form()
        else:
            return self.board()

    def connect_form(self):
        return Padding(
            ConstrainedBox(
                Column(
                    Text("Connect to Bounty", variant="heading"),
                    Text("Generate a token on Bounty under Connections → Workpeg integration, tick the services:read scope, and paste it here. The token is kept in this browser only.", variant="muted"),
                    Container(
                        Column(
                            Input(TextInput(value=self.draft, on_change=self.set_draft,
                                            placeholder="bnt_wp_..."),
                                  label="Your Bounty token"),
                            Text(self.error, tone="danger", visible=self.error != ""),
                            Row(
                                Link("Open Bounty →",
                                     href="https://bounty-workpeg.onrender.com/#/connections/workpeg"),
                                Spacer(),
                                self.connect_button(),
                            ),
                            gap=16,
                        ),
                        variant="card", padding=24,
                    ),
                    gap=16,
                ),
                max_width=640,
            ),
            all=24,
        )

    def connect_button(self):
        if self.connecting:
            return Button("Connecting...", disabled=True)
        else:
            return Button("Connect", on_click=self.connect)

    def board(self):
        if self.loading and len(self.requests) == 0:
            return LoadingState("Loading your requests...")
        elif self.error != "":
            return Padding(
                ErrorState(self.error,
                           Button("Try again", variant="outline-gray",
                                  icon="refresh", on_click=self.refresh)),
                all=24,
            )
        else:
            return Padding(
                Column(
                    self.header(),
                    self.requests_block(),
                    self.visits_block(),
                    gap=24,
                ),
                all=24,
            )

    def header(self):
        return Row(
            Column(
                Text("Your hospitality requests", variant="heading"),
                Text(f"Signed into Bounty as {self.who}" if self.who != "" else "Signed into Bounty",
                     variant="muted"),
                gap=4,
            ),
            Spacer(),
            Button("Refresh", variant="outline-gray", icon="refresh", on_click=self.refresh),
            self.mock_button(),
            self.disconnect_button(),
            gap=8, align="center",
        )

    def mock_button(self):
        if MOCK:
            return Button("Add sample request", variant="outline-gray", on_click=self.add_sample)
        else:
            return Column()

    def disconnect_button(self):
        if MOCK:
            return Column()
        else:
            return Button("Disconnect", variant="ghost-gray", on_click=self.disconnect)

    def requests_block(self):
        if len(self.requests) == 0:
            return Column(
                EmptyState("building", "No requests yet",
                           "Post a request on Bounty to see it here."),
                Row(Spacer(),
                    Link("Open Bounty →",
                         href="https://bounty-workpeg.onrender.com/#/services/new")),
                gap=8,
            )
        else:
            return Column(
                Text("Open requests", weight="semibold"),
                *[self.request_row(r) for r in self.requests],
                gap=8,
            )

    def request_row(self, r):
        return Container(
            Row(
                Column(
                    Text(r.get("title", ""), weight="semibold"),
                    Text(f"{r.get('currency', '')} {r.get('price', 0)} · {r.get('area_label', '')} · {r.get('local_deadline', '')}",
                         variant="muted"),
                    gap=4,
                ),
                Spacer(),
                Tag(f"{r.get('pending_quotes', 0)} pending", tone="accent"),
                Link("Open →",
                     href=f"https://bounty-workpeg.onrender.com/#/services/{r.get('id', '')}"),
                gap=8, align="center",
            ),
            variant="card", padding=16,
        )

    def visits_block(self):
        if len(self.appointments) == 0:
            return Column(Text("Visits", weight="semibold"),
                          Text("No scheduled visits.", variant="muted"),
                          gap=8)
        else:
            return Column(
                Text("Visits", weight="semibold"),
                *[self.visit_row(a) for a in self.appointments],
                gap=8,
            )

    def visit_row(self, a):
        return Container(
            Row(
                Column(
                    Text(a.get("title", ""), weight="semibold"),
                    Text(f"{a.get('local_starts', '')} to {a.get('local_ends', '')}", variant="muted"),
                    gap=4,
                ),
                Spacer(),
                AppointmentStatusTag(a.get("status", "")),
                Link("Open →",
                     href=f"https://bounty-workpeg.onrender.com/#/services/{a.get('bounty_id', '')}"),
                gap=8, align="center",
            ),
            variant="card", padding=16,
        )
