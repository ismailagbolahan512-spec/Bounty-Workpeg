"""Ask Bounty to make a task. A business types what it needs, Bounty's AI drafts the
task, and every step is written into the chat here.

Nothing is posted by the draft. The flow is:
  1. the prompt goes to Bounty's drafter (POST /ai/bounty-draft), which saves nothing;
  2. the draft appears in the chat, where you check it and can change the reward;
  3. Post sends it (POST /bounties). Pressing Post here is your approval. Bounty limits
     how many posts a day and how large a reward a post from Workpeg may carry.

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
    working = State(False)

    async def on_mount(self):
        store.page_title = "Ask Bounty"
        set_title("Ask Bounty")
        self.token = cookie.get(TOKEN_COOKIE)
        if self.token != "":
            self.messages = [{"who": "bounty", "text": "Describe the task you need. I will draft it. Check it, then press Post to publish it on Bounty."}]

    def set_prompt(self, value):
        self.prompt = value

    def set_reward(self, value):
        self.reward = value

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

    async def post_bounty(self):
        # Pressing Post in this chat is the owner's approval. Bounty allows it within a daily
        # limit and a reward cap, and records every post in its audit log.
        if self.working or self.draft == {}:
            return
        p = self.payload()
        if p["reward_amount"] == "" or p["deadline"] == "":
            self.say("bounty", "Set a reward, and make sure the draft has a deadline, before posting.")
            return
        self.working = True
        try:
            res = await http.post(f"{API}/bounties", {"payload": p}, auth=self.token)
            self.draft = {}
            self.say("bounty", f"Posted. Your task is live on Bounty (id {res.get('id', '')}).")
        except Exception as e:
            self.say("bounty", f"Not posted: {e.message}")
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
            return Button("Posting...", disabled=True)
        else:
            return Button("Post to Bounty", on_click=self.post_bounty)
