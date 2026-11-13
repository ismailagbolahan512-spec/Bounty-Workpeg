"""The Bounty page. A business links its Bounty account with a link token made
in Bounty, then reads the open bounties Bounty shares with Workpeg.

Bounty is the system of record. This peg only reads, through /api/peg, with
the token's scope (bounties:read). It keeps no copy of the bounties and holds
no role of its own. The token lives in this page's State only: never in
store, a cookie or a row, so it does not outlive the page.
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Expanded,
    Spacer, Text, Button, Input, TextInput, dates, http, set_title, store,
)

from components import BountyRow, EmptyState, ErrorState, LoadingState

# Bounty's API for Workpeg. Confirm the production host before publishing.
API = "https://bounty-xyty.onrender.com/api/peg"
PAGE = 20


class BountiesPage(App):
    draft = State("")          # the token as typed; cleared once accepted
    token = State("")          # the accepted token (this page only)
    who = State("")            # the Bounty account name it belongs to
    rows = State([])           # display rows, built once per load
    connected = State(False)
    connecting = State(False)
    loading = State(False)
    error = State("")

    async def on_mount(self):
        store.page_title = "Bounty"
        set_title("Bounty")

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
            if "bounties:read" in me["scopes"]:
                self.token = key
                self.who = me["user"]["name"]
                self.draft = ""
                self.connected = True
                await self.load()
            else:
                self.error = "This link cannot read bounties. Make a new link in Bounty."
        except Exception as e:
            self.error = e.message
        self.connecting = False

    async def load(self):
        self.loading = True
        self.error = ""
        try:
            got = await http.get(f"{API}/bounties?limit={PAGE}", auth=self.token)
            self.rows = [{
                "title": r["title"],
                "meta": f"{r['category']} · {r['submission_type']}",
                "reward": f"Reward {r['reward_amount']}",
                "due": "Due " + dates.format(dates.to_epoch(r["deadline"][:19], "UTC"), "medium"),
                "status": r["status"],
            } for r in got["bounties"]]
        except Exception as e:
            self.error = e.message
        self.loading = False

    async def refresh(self):
        await self.load()

    def disconnect(self):
        self.token = ""
        self.who = ""
        self.rows = []
        self.connected = False
        self.error = ""

    def connect_button(self):
        if self.connecting:
            return Button("Connecting...", disabled=True)
        else:
            return Button("Connect", on_click=self.connect)

    def connect_form(self):
        return Padding(
            ConstrainedBox(
                Container(
                    Column(
                        Column(
                            Text("Connect Bounty", variant="heading"),
                            Text("Paste a link token from your Bounty account.",
                                 variant="muted"),
                            gap=4,
                        ),
                        Input(TextInput(value=self.draft, on_change=self.set_draft,
                                        type="password"),
                              label="Link token",
                              hint="Made in Bounty under Settings, Workpeg. Shown once."),
                        Text(self.error, tone="danger", visible=self.error != ""),
                        Row(Spacer(), self.connect_button(), gap=16),
                        gap=24,
                    ),
                    variant="card", padding=24,
                ),
                max_width=720,
            ),
            all=24,
        )

    def board(self):
        return Padding(
            Column(
                Row(
                    Expanded(
                        Column(
                            Text("Open bounties", variant="heading"),
                            Text(f"Connected as {self.who}", variant="muted"),
                            gap=4,
                        ),
                    ),
                    Button("Refresh", variant="outline-gray", icon="refresh",
                           on_click=self.refresh),
                    Button("Disconnect", variant="ghost-gray",
                           on_click=self.disconnect),
                    align="center", gap=16,
                ),
                self.list_body(),
                gap=24,
            ),
            all=24,
        )

    def list_body(self):
        if self.error != "":
            return ErrorState(self.error,
                              Button("Try again", variant="outline-gray",
                                     icon="refresh", on_click=self.refresh))
        elif self.loading and len(self.rows) == 0:
            return LoadingState("Loading bounties...")
        elif len(self.rows) == 0:
            return EmptyState("clipboard", "No open bounties",
                              "Nothing is open for Workpeg right now.",
                              Button("Refresh", variant="outline-gray",
                                     icon="refresh", on_click=self.refresh))
        else:
            return Column(*[
                BountyRow(r["title"], r["meta"], r["reward"], r["due"], r["status"])
                for r in self.rows
            ], gap=16)

    def build(self):
        if self.connected:
            return self.board()
        else:
            return self.connect_form()
