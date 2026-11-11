"""The bounties list: post a job, see every job in this business and open
one. Every state is drawn: loading, error, not set up, empty and the table."""
from workpeg.ui import (
    App, State, Padding, Column, Row, Spacer, Text, Button, Table,
    TableHeader, TableRow, TableCell, Modal, Form, Field, TextInput, Select,
    biz_url, navigate, on_table_change, set_title, store, toast, workpeg,
    required, min_value,
)

from components import (
    BountyStatusTag, EmptyState, ErrorState, LoadingState, PageHeader,
)

# The table's own label, used to find it with get_tables().
TABLE_NAMESPACE = "bounties"
PAGE = 100


class BountiesPage(App):
    table = State("")          # per page: a table uuid belongs to ONE business
    rows = State([])
    limit = State(100)         # the window of rows this page reads (PAGE)
    more = State(False)        # the window was full, so there may be more
    loading = State(True)
    ready = State(False)       # a table exists and the page can write
    needs_setup = State(False)
    setting_up = State(False)
    error = State("")
    adding = State(False)
    saving = State(False)
    title_text = State("")
    category = State("housekeeping")
    description_text = State("")

    async def on_mount(self):
        store.page_title = "Bounties"
        set_title("Bounties")
        on_table_change(self.changed)      # register BEFORE the first await
        await self.load()

    async def changed(self, event):
        await self.load()                  # whatever the kind, fetch again

    async def find_table(self):
        tables = await workpeg.get_tables(TABLE_NAMESPACE)
        if len(tables) > 0:
            self.table = tables[0]["uuid"]
        else:
            self.table = ""
        self.ready = self.table != ""
        self.needs_setup = not self.ready

    async def load(self):
        try:
            if self.table == "":
                await self.find_table()
            if self.table != "":
                rows = await workpeg.get_rows(self.table, limit=self.limit)
                self.rows = rows
                self.more = len(rows) == self.limit
            self.error = ""
        except Exception as e:
            self.error = e.message
        self.loading = False

    async def retry(self):
        self.loading = True
        await self.load()

    async def show_more(self):
        self.limit += PAGE
        await self.load()

    async def set_up(self):
        if self.setting_up or not self.needs_setup:
            return
        self.setting_up = True
        try:
            made = await workpeg.create_table({
                "name": "Bounties",
                "namespace": TABLE_NAMESPACE,
                "permission": "760",
                "columns": [
                    {"id": "title", "name": "Title", "type": "text",
                     "position": 1000, "required": True},
                    {"id": "description", "name": "Description",
                     "type": "text", "position": 2000},
                    {"id": "category", "name": "Category", "type": "text",
                     "position": 3000},
                    {"id": "reward", "name": "Reward", "type": "number",
                     "position": 4000},
                    {"id": "deadline", "name": "Deadline", "type": "text",
                     "position": 5000},
                    {"id": "status", "name": "Status", "type": "text",
                     "position": 6000},
                ],
            })
            self.table = made["uuid"]
            self.ready = True
            self.needs_setup = False
        except Exception as e:
            await self.find_table()        # someone else may have made it
            if self.table == "":
                toast(e.message, kind="danger")
        self.setting_up = False

    def open_add(self):
        self.title_text = ""
        self.category = "housekeeping"
        self.description_text = ""
        self.adding = True

    def close_add(self):
        self.adding = False

    def set_title_text(self, value):
        self.title_text = value

    def set_category(self, value):
        self.category = value

    def set_description(self, value):
        self.description_text = value

    async def save(self, values):
        if self.saving or not self.ready:
            return                 # the button shows the wait; this stops a
        self.saving = True         # second click that lands before it does
        # Rows arrive highest position first; put the new one on top.
        top = self.rows[0]["position"] if len(self.rows) > 0 else 0
        try:
            await workpeg.add_row(self.table, {
                "data": {"title": values["title"],
                         "description": self.description_text,
                         "category": self.category,
                         "reward": int(values["reward"]),
                         "deadline": values["deadline"],
                         "status": "open"},
                "position": top + 1000,
            })
            self.adding = False
            toast("Bounty posted", kind="success")
            await self.load()
        except Exception as e:
            toast(e.message, kind="danger")
        self.saving = False

    def open_bounty(self, row_id):
        navigate(biz_url(f"/bounties/{row_id}"))

    def build(self):
        return Padding(
            Column(
                PageHeader(
                    "Bounties", "Jobs you have posted, newest first.",
                    # One primary action per view: while the list is empty,
                    # the empty state carries it instead.
                    Button("Post bounty", icon="plus", on_click=self.open_add,
                           visible=self.ready and len(self.rows) > 0),
                ),
                self.body(),
                Modal(self.add_form(), open=self.adding,
                      on_close=self.close_add, title="Post a bounty"),
                gap=24,
            ),
            all=24,
        )

    def body(self):
        if self.loading:
            return LoadingState("Loading bounties...")
        elif self.error != "":
            return ErrorState(
                self.error,
                Button("Try again", variant="outline-gray", icon="refresh",
                       on_click=self.retry),
            )
        elif self.needs_setup and self.setting_up:
            return EmptyState(
                "clipboard", "Setting up bounties",
                "Creating the list for this business.",
                Button("Setting up...", disabled=True),
            )
        elif self.needs_setup:
            return EmptyState(
                "clipboard", "No bounty list here yet",
                "It is not set up in this business, or you cannot see it.",
                Button("Set up bounties", on_click=self.set_up),
            )
        elif len(self.rows) == 0:
            return EmptyState(
                "clipboard", "No bounties yet",
                "Post the first job for your team to pick up.",
                Button("Post bounty", icon="plus", on_click=self.open_add),
            )
        else:
            return Table(
                TableHeader(
                    TableCell(title="Title"),
                    TableCell(title="Category"),
                    TableCell(title="Reward"),
                    TableCell(title="Status"),
                    TableCell(title=""),
                ),
                *[TableRow(
                    TableCell(Text(r["data"]["title"], weight="medium")),
                    # Only a required column is read by subscript: a row
                    # written before a column existed has no such key.
                    TableCell(Text(r["data"].get("category", ""),
                                   variant="muted")),
                    TableCell(Text(f"{r['data'].get('reward', 0)}")),
                    TableCell(BountyStatusTag(r["data"].get("status", "open"))),
                    TableCell(
                        Button("", icon="chevron-right", variant="ghost-gray",
                               aria_label="Open bounty",
                               on_click=lambda: self.open_bounty(r["id"])),
                        align="end",
                    ),
                ) for r in self.rows],
                # search and sort act on the rows this page has loaded.
                search="Search bounties",
                sortable=True,
                footer=self.footer(),
            )

    def footer(self):
        if self.more:
            return Row(
                Text(f"Showing the first {len(self.rows)}",
                     variant="caption"),
                Spacer(),
                Button("Show more", variant="outline-gray", size="sm",
                       on_click=self.show_more),
                align="center",
            )
        else:
            return Text(f"{len(self.rows)} bounties", variant="caption")

    def submit_button(self):
        if self.saving:
            return Button("Posting...", disabled=True)
        else:
            return Button("Post bounty", kind="submit")

    def add_form(self):
        return Form(
            Field("title", TextInput(value=self.title_text,
                                     on_change=self.set_title_text,
                                     autofocus=True),
                  label="Title", validators=[required]),
            Field("description", TextInput(value=self.description_text,
                                           on_change=self.set_description),
                  label="What needs doing"),
            Select(
                options=[
                    {"value": "housekeeping", "label": "Housekeeping"},
                    {"value": "kitchen", "label": "Kitchen"},
                    {"value": "events", "label": "Events"},
                    {"value": "maintenance", "label": "Maintenance"},
                    {"value": "front_desk", "label": "Front desk"},
                ],
                value=self.category, on_change=self.set_category,
                label="Category",
            ),
            Field("reward", TextInput(type="number"),
                  label="Reward", validators=[required, min_value(0)]),
            Field("deadline", TextInput(), label="Deadline (optional)"),
            Row(
                Spacer(),
                Button("Cancel", variant="outline-gray",
                       on_click=self.close_add),
                self.submit_button(),
                gap=8,
            ),
            on_submit=self.save,
        )
