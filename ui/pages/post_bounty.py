"""Ask Bounty to make a task. A business types what it needs, Bounty's AI drafts the
task, and every step is written into the chat here.

Nothing is posted by the draft. The flow is:
  1. the prompt goes to Bounty's drafter (POST /ai/bounty-draft), which saves nothing;
  2. the draft appears in the chat, and "Request approval" asks Bounty to approve the exact details;
  3. the owner approves on Bounty's Connections page;
  4. "Post" publishes it (POST /bounties), which uses that approval once.

The token is the one saved on the Services page (a browser cookie). It needs bounties:publish.
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Spacer,
    Text, Button, Link, Input, TextInput, cookie, http, set_title, store,
)

API = "https://bounty-workpeg.onrender.com/api/peg"
TOKEN_COOKIE = "bounty_token"


class PostBountyPage(App):
    token = State("")
    prompt = State("")
    messages = State([])          # the chat: {"who": "you" | "bounty", "text": "..."}
    draft = State({})             # the last draft from Bounty, as returned
    reward = State("")            # reward in naira, prefilled from the draft, editable
    confirmation_id = State("")   # set once Bounty records the approval request
    sent = State({})              # the exact payload that was sent for approval
    working = State(False)

    async def on_mount(self):
        store.page_title = "Ask Bounty"
        set_title("Ask Bounty")
        self.token = cookie.get(TOKEN_COOKIE)
        if self.token != "":
            self.messages = [{"who": "bounty", "text": "Describe the task you need. I will draft it. Nothing is posted until you approve it."}]

    def set_prompt(self, value):
        self.prompt = value

    def set_reward(self, value):
        self.reward = value
        self.confirmation_id = ""

    def say(self, who, text):
        self.messages = self.messages + [{"who": who, "text": text}]

    async def send_prompt(self):
        text = self.prompt.strip()
        if self.working or text == "":
            return
        if self.token == "":
            self.say("bounty", "Connect your Bounty account on the Services page first. Use a token with bounties:publish.")
            return
        self.say("you", text)
        self.prompt = ""
        self.working = True
        try:
            res = await http.post(f"{API}/ai/bounty-draft", {"prompt": text}, auth=self.token)
            d = res.get("draft", {})
            self.draft = d
            self.reward = str(d.get("suggested_reward", {}).get("amount", ""))
            self.confirmation_id = ""
            source = "Bounty's AI" if res.get("source") == "ai" else "Bounty's built-in rules (AI is not connected on the server)"
            self.say("bounty", f"Drafted with {source}: \"{d.get('title', '')}\". Check the reward below, then request approval.")
            for q in d.get("missing_info", []):
                self.say("bounty", f"Missing: {q}")
        except Exception as e:
            self.say("bounty", f"I could not draft that: {e.message}")
        self.working = False

    def payload(self):
        d = self.draft
        deadline = d.get("suggested_deadline") or ""
        requirements = "\n".join(d.get("requirements", []))
        return {
            "title": d.get("title", ""),
            "description": d.get("description", ""),
            "category": d.get("category", "other"),
            "difficulty": d.get("difficulty", "medium"),
            "reward_amount": self.reward.strip(),
            "deadline": deadline,
            "submission_type": d.get("submission_type", "url"),
            "requirements": requirements,
            "currency": "NGN",
        }

    async def request_approval(self):
        if self.working or self.draft == {}:
            return
        p = self.payload()
        if p["reward_amount"] == "" or p["deadline"] == "":
            self.say("bounty", "Set a reward, and make sure the draft has a deadline, before requesting approval.")
            return
        self.working = True
        try:
            res = await http.post(f"{API}/confirmations", {"action": "bounties:publish", "payload": p}, auth=self.token)
            self.sent = p
            self.confirmation_id = res.get("id", "")
            self.say("bounty", "Approval requested. Open Bounty, go to Connections, approve it, then press Post here.")
        except Exception as e:
            self.say("bounty", f"Approval was not requested: {e.message}")
        self.working = False

    async def post_bounty(self):
        if self.working or self.confirmation_id == "":
            return
        self.working = True
        try:
            res = await http.post(f"{API}/bounties", {"confirmation_id": self.confirmation_id, "payload": self.sent}, auth=self.token)
            self.confirmation_id = ""
            self.sent = {}
            self.draft = {}
            self.say("bounty", f"Posted to Bounty. Task id: {res.get('id', '')}.")
        except Exception as e:
            self.say("bounty", f"Not posted: {e.message}. If the approval was used or expired, request approval again.")
        self.working = False

    def build(self):
        if self.token == "":
            return self.no_token()
        else:
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
                                        placeholder="Example: clean and repair the three guest rooms in Lekki before Friday"),
                              label="Your request"),
                        self.send_button(),
                        gap=8, align="end",
                    ),
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
                    Text(f"Deadline: {self.draft.get('suggested_deadline', '') or 'not set'}", variant="muted"),
                    Row(Spacer(), self.approve_button()),
                    gap=12,
                ),
                variant="card", padding=16,
            )

    def send_button(self):
        if self.working:
            return Button("Working...", disabled=True)
        else:
            return Button("Send", on_click=self.send_prompt)

    def approve_button(self):
        if self.working:
            return Button("Working...", disabled=True)
        elif self.confirmation_id == "":
            return Button("Request approval", variant="outline-gray", on_click=self.request_approval)
        else:
            return Row(
                Button("Request approval again", variant="outline-gray", on_click=self.request_approval),
                Button("Post", on_click=self.post_bounty),
                gap=8,
            )
