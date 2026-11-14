"""Ask Bounty to make a task, in MOCK mode: the peg keeps everything in this business's
Workpeg tables, so the whole flow works while Workpeg cannot reach Bounty's server.

  1. you type what the task is; the peg drafts it with local rules (no outside call);
  2. the draft appears in the chat, where you set the reward and check the deadline;
  3. Post writes a row to the Bounties table; updates appear in the chat.

Set MOCK to False to send the same steps to Bounty's live API instead. That needs
Workpeg to reach the server and a saved token (Services page).
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Spacer,
    Text, Button, Link, Input, TextInput, Tag, cookie, set_interval, set_title, store,
    workpeg,
)

MOCK = True
API = "https://bounty-workpeg.onrender.com/api/peg"
TOKEN_COOKIE = "bounty_token"
BOUNTY_NS = "bounty-mock-bounties"
UPDATE_NS = "bounty-mock-updates"


class PostBountyPage(App):
    token = State("")
    prompt = State("")
    messages = State([])          # the chat: {"who": "you" | "bounty", "text": "..."}
    draft = State({})             # the current draft: title, description, deadline, missing
    reward = State("")            # reward in naira, typed by you
    deadline = State("")          # deadline phrase from the draft, editable
    posted = State([])            # tasks already posted from this business
    working = State(False)
    ready = State(False)          # tables found or created
    cursor = State(0)             # how many update rows are already in the chat
    bounties_table = State("")
    updates_table = State("")

    async def on_mount(self):
        store.page_title = "Ask Bounty"
        set_title("Ask Bounty")
        set_interval(self.check_updates, 30000)
        self.token = cookie.get(TOKEN_COOKIE)
        if MOCK or self.token != "":
            self.messages = [{"who": "bounty", "text": "Describe the task you need. I will draft it. Set the reward and check the deadline, then press Post."}]
            await self.setup()

    async def setup(self):
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
            self.say("bounty", "I am still connecting to this business. Try again in a moment.")
            return
        self.say("you", text)
        self.prompt = ""
        d = self.make_draft(text)
        self.draft = d
        self.deadline = d["deadline"]
        self.reward = ""
        self.say("bounty", "Drafted: \"" + d["title"] + "\". Set the reward below, check the deadline, then press Post.")
        for q in d["missing"]:
            self.say("bounty", "Missing: " + q)

    async def post_bounty(self):
        # Pressing Post in this chat is the owner's approval.
        if self.working or self.draft == {}:
            return
        if self.reward.strip() == "" or self.deadline.strip() == "":
            self.say("bounty", "Set the reward and the deadline before posting.")
            return
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
        # Demo only: stands in for a worker taking a task, so the update flow can be shown.
        try:
            rows = await workpeg.get_rows(self.updates_table, limit=200)
            await workpeg.add_row(self.updates_table, {
                "data": {"message": "A worker has taken one of your tasks."},
                "position": (len(rows) + 1) * 1000,
            })
        except Exception as e:
            self.say("bounty", "Could not add the update: " + e.message)

    def build(self):
        if not MOCK and self.token == "":
            return self.no_token()
        return self.chat()

    def no_token(self):
        return Padding(
            ConstrainedBox(
                Container(
                    Column(
                        Text("Connect first", variant="heading"),
                        Text("Connect your Bounty account on the Services page, using a token that has bounties:publish.", variant="muted"),
                        Row(Spacer(), Link("Go to Services", href="#/services")),
                        gap=16,
                    ),
                    variant="card", padding=24,
                ),
                max_width=640,
            ),
            all=24,
        )

    def chat(self):
        return Padding(
            ConstrainedBox(
                Column(
                    Text("Ask Bounty to make a task", variant="heading"),
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
                    Input(TextInput(value=self.deadline, on_change=self.set_deadline, placeholder="for example Friday"),
                          label="Deadline"),
                    Row(Spacer(), self.approve_button()),
                    gap=12,
                ),
                variant="card", padding=16,
            )

    def posted_list(self):
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
        if MOCK:
            return Button("Demo: a worker takes a task", variant="outline-gray", on_click=self.demo_take)
        else:
            return Column()

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
