"""The bounty page: read one job, submit work to it, review what was sent
back, change its status and delete it after asking."""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Expanded,
    Spacer, Text, Button, Input, TextInput, Select, Divider, Link, Modal,
    biz_url, dates, navigate, on_table_change, route, set_title, store,
    toast, workpeg,
)

from components import (
    BountyStatusTag, ErrorState, LoadingState, SubmissionStatusTag,
)

TABLE_NAMESPACE = "bounties"
SUBMISSIONS_NAMESPACE = "submissions"
# Submissions are read in one window and filtered to this bounty.
SUB_WINDOW = 200


class BountyPage(App):
    table = State("")           # bounty table uuid (per page)
    subs_table = State("")      # submissions table uuid (per page)
    bounty_id = State(0)
    bounty = State({})
    subs = State([])
    loading = State(True)
    error = State("")
    status = State("open")
    worker_name = State("")
    note = State("")
    saving = State(False)
    confirming = State(False)
    deleting = State(False)

    async def on_mount(self):
        store.page_title = "Bounty"
        # route.* is a live read of the URL: capture it before any await.
        self.bounty_id = int(route.bounty_id)
        on_table_change(self.changed)
        try:
            tables = await workpeg.get_tables(TABLE_NAMESPACE)
            if len(tables) == 0:
                self.error = ("This business has no bounties list, or you "
                              "cannot see it.")
            else:
                self.table = tables[0]["uuid"]
                self.show(await workpeg.get_row(self.table, self.bounty_id))
                sub_tables = await workpeg.get_tables(SUBMISSIONS_NAMESPACE)
                if len(sub_tables) > 0:
                    self.subs_table = sub_tables[0]["uuid"]
                await self.load_subs()
        except Exception as e:
            self.error = e.message
        self.loading = False

    async def changed(self, event):
        await self.load_subs()

    def show(self, row):
        self.bounty = row
        self.status = row["data"].get("status", "open")
        set_title(row["data"]["title"])

    async def load_subs(self):
        if self.subs_table == "":
            self.subs = []
            return
        rows = await workpeg.get_rows(self.subs_table, limit=SUB_WINDOW)
        mine = []
        for r in rows:
            if f"{r['data'].get('bounty_id', '')}" == f"{self.bounty_id}":
                mine.append(r)
        self.subs = mine

    def set_status(self, value):
        self.status = value

    def set_worker_name(self, value):
        self.worker_name = value

    def set_note(self, value):
        self.note = value

    async def write_bounty_status(self, new_status):
        # update_row replaces `data` whole: copy every column, change status.
        data = {}
        for key in self.bounty["data"]:
            data[key] = self.bounty["data"][key]
        data["status"] = new_status
        self.show(await workpeg.update_row(
            self.table, self.bounty_id, {"data": data}))

    async def save_status(self):
        if self.saving or self.status == self.bounty["data"].get("status", "open"):
            return
        self.saving = True
        try:
            await self.write_bounty_status(self.status)
            toast("Status saved", kind="success")
        except Exception as e:
            self.status = self.bounty["data"].get("status", "open")
            toast(e.message, kind="danger")
        self.saving = False

    async def submit_work(self):
        if self.saving:
            return
        if self.worker_name == "":
            toast("Add your name before submitting", kind="danger")
            return
        if self.status == "approved" or self.status == "closed":
            toast("This bounty is no longer taking work", kind="danger")
            return
        self.saving = True
        try:
            if self.subs_table == "":
                made = await workpeg.create_table({
                    "name": "Submissions",
                    "namespace": SUBMISSIONS_NAMESPACE,
                    "permission": "760",
                    "columns": [
                        {"id": "bounty_id", "name": "Bounty", "type": "text",
                         "position": 1000, "required": True},
                        {"id": "worker", "name": "Worker", "type": "text",
                         "position": 2000, "required": True},
                        {"id": "note", "name": "Note", "type": "text",
                         "position": 3000},
                        {"id": "status", "name": "Status", "type": "text",
                         "position": 4000},
                    ],
                })
                self.subs_table = made["uuid"]
            # Rows arrive highest position first; put the new one on top.
            top = 0
            recent = await workpeg.get_rows(self.subs_table, limit=1)
            if len(recent) > 0:
                top = recent[0]["position"]
            await workpeg.add_row(self.subs_table, {
                "data": {"bounty_id": f"{self.bounty_id}",
                         "worker": self.worker_name,
                         "note": self.note,
                         "status": "pending"},
                "position": top + 1000,
            })
            if self.status == "open":
                await self.write_bounty_status("submitted")
            self.worker_name = ""
            self.note = ""
            await self.load_subs()
            toast("Work submitted", kind="success")
        except Exception as e:
            toast(e.message, kind="danger")
        self.saving = False

    async def decide(self, sub_id, decision):
        if self.saving:
            return
        self.saving = True
        try:
            sub = next((s for s in self.subs if s["id"] == sub_id), None)
            if sub is None:
                toast("That submission is gone. Refresh the page.",
                      kind="danger")
            else:
                data = {}
                for key in sub["data"]:
                    data[key] = sub["data"][key]
                data["status"] = decision
                await workpeg.update_row(self.subs_table, sub_id,
                                         {"data": data})
                # Approving closes the job; rejecting reopens it for work.
                if decision == "approved":
                    await self.write_bounty_status("approved")
                else:
                    await self.write_bounty_status("open")
                await self.load_subs()
                toast("Submission " + decision, kind="success")
        except Exception as e:
            toast(e.message, kind="danger")
        self.saving = False

    def ask_delete(self):
        self.confirming = True

    def cancel_delete(self):
        self.confirming = False

    async def remove(self):
        if self.deleting:
            return
        self.deleting = True
        try:
            # The job's submissions go with it, so nothing is left orphaned.
            for s in self.subs:
                await workpeg.delete_row(self.subs_table, s["id"])
            await workpeg.delete_row(self.table, self.bounty_id)
            self.confirming = False
            toast("Bounty deleted", kind="success")
            navigate(biz_url("/bounties"))
        except Exception as e:
            toast(e.message, kind="danger")
        self.deleting = False

    def back(self):
        navigate(biz_url("/bounties"))

    def save_button(self):
        if self.saving:
            return Button("Saving...", disabled=True)
        else:
            return Button("Save status", variant="outline-gray",
                          on_click=self.save_status)

    def submit_button(self):
        if self.saving:
            return Button("Submitting...", disabled=True)
        else:
            return Button("Submit work", icon="send",
                          on_click=self.submit_work)

    def submissions(self):
        if len(self.subs) == 0:
            return Text("No work submitted yet.", variant="muted")
        else:
            return Column(
                *[Container(
                    Row(
                        Expanded(
                            Column(
                                Text(s["data"].get("worker", ""),
                                     weight="semibold"),
                                Text(s["data"].get("note", ""),
                                     variant="muted"),
                                gap=4,
                            ),
                        ),
                        SubmissionStatusTag(s["data"].get("status", "pending")),
                        Button("Approve", icon="check", size="sm",
                               visible=s["data"].get("status", "pending") == "pending",
                               on_click=lambda: self.decide(s["id"], "approved")),
                        Button("Reject", variant="outline-gray", size="sm",
                               visible=s["data"].get("status", "pending") == "pending",
                               on_click=lambda: self.decide(s["id"], "rejected")),
                        align="center", gap=12,
                    ),
                    variant="card", padding=16,
                ) for s in self.subs],
                gap=12,
            )

    def submit_card(self):
        return Container(
            Column(
                Text("Submit your work", weight="semibold"),
                Divider(),
                Input(
                    TextInput(value=self.worker_name,
                              on_change=self.set_worker_name),
                    label="Your name",
                ),
                Input(
                    TextInput(value=self.note, on_change=self.set_note),
                    label="What did you do?",
                    hint="A short note helps the reviewer.",
                ),
                self.submit_button(),
                gap=12,
            ),
            variant="card", padding=24,
        )

    def build(self):
        if self.loading:
            return LoadingState("Loading bounty...")
        elif self.error != "":
            return Padding(
                ErrorState(
                    self.error,
                    Button("Back to bounties", variant="outline-gray",
                           icon="arrow-left", on_click=self.back),
                ),
                all=24,
            )
        else:
            return Padding(
                ConstrainedBox(
                    Column(
                        Link("Bounties", href=biz_url("/bounties"),
                             icon="arrow-left"),
                        Row(
                            Expanded(
                                Column(
                                    Row(
                                        Text(self.bounty["data"]["title"],
                                             variant="heading"),
                                        BountyStatusTag(self.status),
                                        align="center", gap=8,
                                    ),
                                    Text("Posted " + dates.format(
                                        dates.to_epoch(
                                            self.bounty["created_at"][:19],
                                            "UTC"),
                                        "medium"), variant="caption"),
                                    gap=4,
                                ),
                            ),
                            Button("Delete", variant="outline-gray",
                                   error=True, icon="trash",
                                   on_click=self.ask_delete),
                            align="center", gap=16,
                        ),
                        Container(
                            Column(
                                Text("Details", weight="semibold"),
                                Divider(),
                                Text(self.bounty["data"].get("description", ""),
                                     variant="muted"),
                                Text(f"Category: {self.bounty['data'].get('category', '')}",
                                     variant="caption"),
                                Text(f"Reward: {self.bounty['data'].get('reward', 0)}",
                                     variant="caption"),
                                Text(f"Deadline: {self.bounty['data'].get('deadline', '') or 'none'}",
                                     variant="caption"),
                                Row(
                                    Select(
                                        options=[
                                            {"value": "open", "label": "Open"},
                                            {"value": "submitted", "label": "Submitted"},
                                            {"value": "approved", "label": "Approved"},
                                            {"value": "closed", "label": "Closed"},
                                        ],
                                        value=self.status,
                                        on_change=self.set_status,
                                        label="Status",
                                    ),
                                    self.save_button(),
                                    align="end", gap=8,
                                ),
                                gap=12,
                            ),
                            variant="card", padding=24,
                        ),
                        self.submit_card(),
                        Container(
                            Column(
                                Text("Submitted work", weight="semibold"),
                                Divider(),
                                self.submissions(),
                                gap=12,
                            ),
                            variant="card", padding=24,
                        ),
                        Modal(
                            Column(
                                Text("Delete this bounty and its submissions?"),
                                Row(
                                    Spacer(),
                                    Button("Cancel", variant="outline-gray",
                                           on_click=self.cancel_delete),
                                    Button("Delete", error=True,
                                           on_click=self.remove),
                                    gap=8,
                                ),
                                gap=16,
                            ),
                            open=self.confirming,
                            on_close=self.cancel_delete,
                            title="Delete bounty",
                        ),
                        gap=24,
                    ),
                    max_width=720,
                ),
                all=24,
            )
