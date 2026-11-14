"""Ask Bounty to make a task, from the Workpeg chat. Two modes, switched on this page:

  MOCK (default, off the switch): the peg keeps tasks in this business's Workpeg tables.
    Works while Workpeg cannot reach Bounty's server. Updates are demo rows.
  LIVE (switch on, paste a Bounty token): the peg posts to Bounty's API, POST /api/peg/bounties,
    and reads notifications from GET /api/peg/notifications. Needs Workpeg to be allowed to reach
    Bounty's server, and a token from Bounty with the bounties:publish scope.
    The token is held in this page only. It is not saved in a cookie (cookies are shared by every
    Workpeg peg), not written to code, and it is gone when the page reloads.

Both modes: you type the task; the peg drafts it with local rules; you set the reward and the
deadline; Post. In live mode the deadline is a date such as 2026-11-20.
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Spacer,
    Text, Button, Input, TextInput, Switch, Tag, set_interval, set_title, store,
    http, workpeg,
)

API = "https://bounty-workpeg.onrender.com/api/peg"
BOUNTY_NS = "bounty-mock-bounties"
UPDATE_NS = "bounty-mock-updates"
DIGITS = "0123456789"
LIVE_TIME = "T23:59:00+01:00"   # a live deadline is the end of the chosen day, Lagos time


class PostBountyPage(App):
    live = State(False)           # False: mock. True: post to Bounty's API.
    token = State("")             # live only: the Bounty token, held in this page's memory only
    prompt = State("")
    messages = State([])          # the chat: {"who": "you" | "bounty", "text": "..."}
    draft = State({})             # the current draft: title, description, deadline, missing
    reward = State("")            # reward in naira, typed by you
    deadline = State("")          # deadline from the draft, editable
    posted = State([])            # tasks already posted from this business (mock)
    live_tasks = State([])        # live: this business's tasks on Bounty, with progress
    pending = State("")           # the question the peg is waiting on: "", "reward", "deadline", "workers" or "confirm"
    workers = State("")           # how many workers may take the task, 1 to 50 (blank means 3)
    working = State(False)
    ready = State(False)          # ready to take a request
    cursor = State(0)             # mock: how many update rows are already in the chat
    since = State("")             # live: the time of the newest notification shown
    bounties_table = State("")
    updates_table = State("")

    async def on_mount(self):
        store.page_title = "Ask Bounty"
        set_title("Ask Bounty")
        set_interval(self.check_updates, 30000)
        self.messages = [{"who": "bounty", "text": "Tell me the task you need. I will ask what I need to know, then post it when you say yes."}]
        await self.setup()

    async def setup(self):
        if self.live:
            self.ready = self.token != ""
            return
        try:
            self.bounties_table = await self.find_or_make(BOUNTY_NS, "Bounties (mock)", [
                {"id": "title", "name": "Title", "type": "text", "position": 1000, "required": True},
                {"id": "description", "name": "Description", "type": "text", "position": 2000},
                {"id": "reward", "name": "Reward (NGN)", "type": "text", "position": 3000},
                {"id": "deadline", "name": "Deadline", "type": "text", "position": 4000},
                {"id": "status", "name": "Status", "type": "text", "position": 5000},
            ])
            self.updates_table = await self.find_or_make(UPDATE_NS, "Updates (mock)", [
                {"id": "message", "name": "Message", "type": "text", "position": 1000, "required": True},
            ])
            updates = await workpeg.get_rows(self.updates_table, limit=200)
            self.cursor = len(updates)
            await self.load_posted()
            self.ready = True
        except Exception as e:
            self.say("bounty", "I could not reach this business's task tables: " + e.message)

    async def find_or_make(self, ns, name, columns):
        tables = await workpeg.get_tables(ns)
        if len(tables) > 0:
            return tables[0]["uuid"]
        made = await workpeg.create_table({
            "name": name,
            "namespace": ns,
            "permission": "760",
            "columns": columns,
        })
        return made["uuid"]

    async def load_posted(self):
        rows = await workpeg.get_rows(self.bounties_table, limit=50)
        self.posted = rows

    async def set_live(self, value):
        self.live = value
        self.posted = []
        self.draft = {}
        self.ready = False
        await self.setup()
        if value:
            self.say("bounty", "Live mode: tasks go to Bounty. Paste your Bounty token, then send your request.")
        else:
            self.say("bounty", "Mock mode: tasks stay in this business's Workpeg tables.")

    def set_token(self, value):
        self.token = value
        if self.live:
            self.ready = value != ""

    def set_prompt(self, value):
        self.prompt = value

    def set_reward(self, value):
        self.reward = value

    def set_deadline(self, value):
        self.deadline = value

    def say(self, who, text):
        self.messages = self.messages + [{"who": who, "text": text}]

    async def check_updates(self):
        # Every 30 seconds: show updates that arrived since the last check, oldest first.
        if not self.ready or self.working:
            return
        if self.live:
            await self.check_live()
        else:
            await self.check_mock()

    async def check_live(self):
        try:
            url = API + "/notifications"
            if self.since != "":
                url = url + "?since=" + self.since
            rows = await http.get(url, auth=self.token)
            for r in rows:
                self.say("bounty", "Update: " + r.get("message", ""))
            if len(rows) > 0:
                self.since = rows[len(rows) - 1]["created_at"]
        except Exception:
            pass
        try:
            self.live_tasks = await http.get(API + "/business/bounties", auth=self.token)
        except Exception:
            pass

    async def check_mock(self):
        try:
            rows = await workpeg.get_rows(self.updates_table, limit=200)
            fresh = len(rows) - self.cursor
            if fresh > 0:
                for r in rows[:fresh][::-1]:
                    self.say("bounty", "Update: " + r["data"].get("message", ""))
                self.cursor = len(rows)
        except Exception:
            pass

    def find_deadline(self, text):
        low = text.lower()
        days = ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        found = ""
        for d in days:
            if d in low:
                found = d
        return found

    def make_draft(self, text):
        title = text[:80]
        if len(text) > 80:
            title = title + "..."
        deadline = self.find_deadline(text)
        missing = []
        if deadline == "":
            missing.append("a deadline, for example by Friday")
        return {"title": title, "description": text, "deadline": deadline, "missing": missing}

    async def send_prompt(self):
        text = self.prompt.strip()
        if self.working or text == "":
            return
        if not self.ready:
            if self.live:
                self.say("bounty", "Paste your Bounty token first, then send your request.")
            else:
                self.say("bounty", "I am still connecting to this business. Try again in a moment.")
            return
        self.say("you", text)
        self.prompt = ""
        if self.pending == "":
            self.start_task(text)
        else:
            await self.answer(text)

    def start_task(self, text):
        d = self.make_draft(text)
        self.draft = d
        self.deadline = ""
        self.reward = ""
        self.workers = ""
        self.say("bounty", "Got it: \"" + d["title"] + "\". I need a few details before I post it.")
        self.ask_next()

    def ask_next(self):
        if self.reward.strip() == "":
            self.pending = "reward"
            self.say("bounty", "What is the reward, in naira? For example 25000.")
        elif self.deadline.strip() == "":
            self.pending = "deadline"
            self.say("bounty", "What is the deadline? Give the date as 2026-11-20.")
        elif self.workers.strip() == "":
            self.pending = "workers"
            self.say("bounty", "How many workers may take it, from 1 to 50? Say 3 for the usual.")
        else:
            self.pending = "confirm"
            self.say("bounty", "Ready to post: \"" + self.draft.get("title", "") + "\", reward " + self.reward.strip() +
                     " naira, deadline " + self.deadline.strip() + ", " + self.workers.strip() +
                     " workers. Reply yes to post it, or cancel to stop.")

    def valid_date(self, day):
        return len(day) == 10 and day[4:5] == "-" and day[7:8] == "-" and all(c in DIGITS or c == "-" for c in day)

    def cancel(self):
        self.pending = ""
        self.draft = {}
        self.reward = ""
        self.deadline = ""
        self.workers = ""
        self.say("bounty", "Cancelled. Tell me about a new task when you are ready.")

    async def answer(self, text):
        low = text.lower().strip()
        if low == "cancel" or (self.pending == "confirm" and low in ["no", "n"]):
            self.cancel()
            return
        if self.pending == "reward":
            figure = "".join([c for c in text if c != ","]).strip()
            if figure == "" or not all(c in DIGITS for c in figure):
                self.say("bounty", "The reward must be a whole number of naira, for example 25000.")
                return
            self.reward = figure
            self.ask_next()
        elif self.pending == "deadline":
            if not self.valid_date(text.strip()):
                self.say("bounty", "Give the date as 2026-11-20, or say cancel.")
                return
            self.deadline = text.strip()
            self.ask_next()
        elif self.pending == "workers":
            figure = text.strip()
            if figure == "":
                self.workers = "3"
            elif not all(c in DIGITS for c in figure) or int(figure) < 1 or int(figure) > 50:
                self.say("bounty", "Give a whole number from 1 to 50, or 3 for the usual.")
                return
            else:
                self.workers = figure
            self.ask_next()
        elif self.pending == "confirm":
            if low in ["yes", "y", "post", "post it"]:
                self.pending = ""
                await self.post_bounty()
            else:
                self.say("bounty", "Reply yes to post it, or cancel to stop.")

    async def post_bounty(self):
        # Pressing Post in this chat is the owner's approval.
        if self.working or self.draft == {}:
            return
        if self.reward.strip() == "" or self.deadline.strip() == "":
            self.say("bounty", "I still need the reward and the deadline before I can post.")
            return
        if self.live:
            await self.post_live()
        else:
            await self.post_mock()

    async def post_live(self):
        reward = self.reward.strip()
        day = self.deadline.strip()
        if not all(c in DIGITS for c in reward):
            self.say("bounty", "The reward must be a whole number of naira, for example 25000.")
            return
        if len(day) != 10 or day[4:5] != "-" or day[7:8] != "-":
            self.say("bounty", "In live mode the deadline is a date, for example 2026-11-20.")
            return
        count = 3
        if self.workers.strip() != "":
            count = int(self.workers.strip())
        self.working = True
        try:
            await http.post(API + "/bounties", {
                "payload": {
                    "title": self.draft.get("title", ""),
                    "description": self.draft.get("description", ""),
                    "category": "other",
                    "difficulty": "easy",
                    "reward_amount": reward,
                    "deadline": day + LIVE_TIME,
                    "submission_type": "text",
                    "max_workers": count,
                },
            }, auth=self.token)
            self.posted = self.posted + [{"data": {"title": self.draft.get("title", ""), "status": "open"}}]
            self.draft = {}
            self.reward = ""
            self.deadline = ""
            self.say("bounty", "Posted to Bounty.")
        except Exception as e:
            self.say("bounty", "Not posted: " + e.message)
        self.working = False

    async def post_mock(self):
        self.working = True
        try:
            rows = await workpeg.get_rows(self.bounties_table, limit=200)
            await workpeg.add_row(self.bounties_table, {
                "data": {
                    "title": self.draft.get("title", ""),
                    "description": self.draft.get("description", ""),
                    "reward": self.reward.strip(),
                    "deadline": self.deadline.strip(),
                    "status": "open",
                },
                "position": (len(rows) + 1) * 1000,
            })
            self.draft = {}
            self.reward = ""
            self.deadline = ""
            await self.load_posted()
            self.say("bounty", "Posted. Your task is live in the list below.")
        except Exception as e:
            self.say("bounty", "Not posted: " + e.message)
        self.working = False

    async def demo_take(self):
        # Mock only: stands in for a worker taking a task, so the update flow can be shown.
        try:
            rows = await workpeg.get_rows(self.updates_table, limit=200)
            await workpeg.add_row(self.updates_table, {
                "data": {"message": "A worker has taken one of your tasks."},
                "position": (len(rows) + 1) * 1000,
            })
        except Exception as e:
            self.say("bounty", "Could not add the update: " + e.message)

    def build(self):
        return self.chat()

    def chat(self):
        return Padding(
            ConstrainedBox(
                Column(
                    Text("Ask Bounty to make a task", variant="heading"),
                    self.mode_box(),
                    Container(
                        Column(*[self.bubble(m) for m in self.messages], gap=12),
                        variant="card", padding=16,
                    ),
                    self.draft_card(),
                    Row(
                        Input(TextInput(value=self.prompt, on_change=self.set_prompt,
                                        placeholder="Example: clean and repair the three guest rooms in Lekki by Friday"),
                              label="Your request"),
                        self.send_button(),
                        gap=8, align="end",
                    ),
                    self.posted_list(),
                    self.demo_button(),
                    gap=16,
                ),
                max_width=720,
            ),
            all=24,
        )

    def mode_box(self):
        if self.live:
            return Column(self.mode_switch(), self.token_field(), gap=12)
        else:
            return self.mode_switch()

    def mode_switch(self):
        return Switch(checked=self.live, on_change=self.set_live, label="Post to Bounty (live)")

    def token_field(self):
        return Input(TextInput(value=self.token, on_change=self.set_token, type="password",
                               placeholder="Paste your Bounty token"),
                     label="Bounty token",
                     hint="Kept in this page only. Reloading the page clears it.")

    def bubble(self, m):
        if m.get("who", "") == "you":
            return Row(Spacer(), Container(Text(m.get("text", "")), variant="card", padding=12))
        else:
            return Text(m.get("text", ""), variant="muted")

    def draft_card(self):
        if self.draft == {}:
            return Column()
        else:
            return Container(
                Column(
                    Text(self.draft.get("title", ""), variant="heading"),
                    Text(self.draft.get("description", ""), variant="muted"),
                    Input(TextInput(value=self.reward, on_change=self.set_reward, placeholder="25000"),
                          label="Reward (NGN)"),
                    Input(TextInput(value=self.deadline, on_change=self.set_deadline,
                                    placeholder="Friday, or 2026-11-20 in live mode"),
                          label="Deadline"),
                    Row(Spacer(), self.approve_button()),
                    gap=12,
                ),
                variant="card", padding=16,
            )

    def live_row(self, t):
        return Column(
            Row(Text(t["title"], weight="semibold"), Spacer(), Tag(t["status"], tone="neutral"),
                gap=8, align="center"),
            Text(f"{t['taken']} of {t['max_workers']} workers taken · {t['submitted']} submitted · {t['approved']} approved", variant="muted"),
            gap=4,
        )

    def live_list(self):
        if len(self.live_tasks) == 0:
            return Column()
        return Container(
            Column(
                Text("Your tasks", variant="heading"),
                *[self.live_row(t) for t in self.live_tasks],
                gap=12,
            ),
            variant="card", padding=16,
        )

    def posted_list(self):
        if self.live:
            return self.live_list()
        if len(self.posted) == 0:
            return Column()
        else:
            return Container(
                Column(
                    Text("Your tasks", variant="heading"),
                    *[Row(Text(p["data"].get("title", ""), weight="semibold"),
                          Spacer(),
                          Tag(p["data"].get("status", "open"), tone="success"),
                          gap=8, align="center") for p in self.posted],
                    gap=8,
                ),
                variant="card", padding=16,
            )

    def demo_button(self):
        if self.live:
            return Column()
        else:
            return Button("Demo: a worker takes a task", variant="outline-gray", on_click=self.demo_take)

    def send_button(self):
        if self.working:
            return Button("Working...", disabled=True)
        else:
            return Button("Send", on_click=self.send_prompt)

    def approve_button(self):
        if self.working:
            return Button("Posting...", disabled=True)
        else:
            return Button("Post", on_click=self.post_bounty)
