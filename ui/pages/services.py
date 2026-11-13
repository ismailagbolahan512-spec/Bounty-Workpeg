"""The services page. A business links its Bounty account with a token made
on Bounty, then reads the hospitality requests, quotes and visits it owns.

Bounty is the system of record. This peg only reads, through /api/peg, with
the token's scope (services:read). It keeps no copy of the data and holds
no role of its own. The token lives in a peg-scoped cookie so the connection
survives page switches; the Disconnect button removes it.
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Expanded,
    Spacer, Text, Button, Link, Tag, Input, TextInput, cookie, http, set_title, store,
)

from components import EmptyState, ErrorState, LoadingState, AppointmentStatusTag

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

    async def on_mount(self):
        store.page_title = "Hospitality services"
        set_title("Hospitality services")
        saved = cookie.get(TOKEN_COOKIE)
        if saved != "":
            self.token = saved
            await self.load()

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
        cookie.set(TOKEN_COOKIE, "")
        self.token = ""
        self.who = ""
        self.requests = []
        self.appointments = []
        self.error = ""

    async def load(self):
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
            Button("Disconnect", variant="ghost-gray", on_click=self.disconnect),
            gap=8, align="center",
        )

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
