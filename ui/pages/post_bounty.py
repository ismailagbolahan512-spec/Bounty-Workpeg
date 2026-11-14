"""The post-a-bounty page. A business types a bounty here, approves it on Bounty,
then posts it. Bounty is the system of record: this page holds no copy of the
bounty, only the form and the approval id until the post goes through.

Posting is two steps on purpose. Step one asks Bounty for an approval of the exact
details (POST /confirmations). The owner approves on Bounty's Connections page.
Step two posts (POST /bounties) with that approval, which Bounty uses once.
The token comes from the Services page (the same browser cookie). It needs the
bounties:publish scope.
"""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, ConstrainedBox, Spacer,
    Text, Button, Link, Input, TextInput, Select, cookie, http, set_title, store,
)

API = "https://bounty-workpeg.onrender.com/api/peg"
TOKEN_COOKIE = "bounty_token"
# Deadlines are typed in Lagos time (UTC+1), the time at the place of the work.
LAGOS_OFFSET = "+01:00"

CATEGORIES = ["dev", "design", "content", "marketing", "other"]
DIFFICULTIES = ["easy", "medium", "hard"]
SUBMISSION_TYPES = ["text", "url", "github", "file"]


class PostBountyPage(App):
    token = State("")
    title = State("")
    description = State("")
    category = State("dev")
    difficulty = State("easy")
    reward = State("")
    deadline = State("")          # typed as 2026-11-20T14:00 (Lagos time)
    submission_type = State("text")
    requirements = State("")
    confirmation_id = State("")   # set once Bounty has recorded the approval request
    sent = State({})              # the exact details that were sent for approval
    posted_link = State("")
    notice = State("")
    error = State("")
    busy = State(False)

    async def on_mount(self):
        store.page_title = "Post a bounty"
        set_title("Post a bounty")
        self.token = cookie.get(TOKEN_COOKIE)

    def set_title_text(self, value):
        self.title = value
        self.confirmation_id = ""

    def set_description(self, value):
        self.description = value
        self.confirmation_id = ""

    def set_category(self, value):
        self.category = value
        self.confirmation_id = ""

    def set_difficulty(self, value):
        self.difficulty = value
        self.confirmation_id = ""

    def set_reward(self, value):
        self.reward = value
        self.confirmation_id = ""

    def set_deadline(self, value):
        self.deadline = value
        self.confirmation_id = ""

    def set_submission_type(self, value):
        self.submission_type = value
        self.confirmation_id = ""

    def set_requirements(self, value):
        self.requirements = value
        self.confirmation_id = ""

    def details(self):
        # The same shape Bounty validates. The approval covers exactly this object.
        return {
            "title": self.title.strip(),
            "description": self.description.strip(),
            "category": self.category,
            "difficulty": self.difficulty,
            "reward_amount": self.reward.strip(),
            "deadline": self.deadline.strip() + ":00" + LAGOS_OFFSET,
            "submission_type": self.submission_type,
            "requirements": self.requirements.strip(),
            "currency": "NGN",
        }

    def check_form(self):
        if self.token == "":
            return "Connect on the Services page first, with a token that has bounties:publish."
        if len(self.title.strip()) < 3:
            return "Add a title of at least 3 characters."
        if len(self.description.strip()) < 10:
            return "Describe the bounty in at least 10 characters."
        if self.reward.strip() == "":
            return "Add the reward amount, for example 25000."
        if len(self.deadline.strip()) != 16:
            return "Set the deadline as 2026-11-20T14:00 (Lagos time)."
        return ""

    async def request_approval(self):
        if self.busy:
            return
        problem = self.check_form()
        if problem != "":
            self.error = problem
            return
        self.busy = True
        self.error = ""
        self.posted_link = ""
        try:
            details = self.details()
            res = await http.post(f"{API}/confirmations",
                                  {"action": "bounties:publish", "payload": details},
                                  auth=self.token)
            self.sent = details
            self.confirmation_id = res.get("id", "")
            self.notice = "Approval requested. Open Bounty → Connections, approve the bounty, then press Post."
        except Exception as e:
            self.error = e.message
        self.busy = False

    async def post_bounty(self):
        if self.busy or self.confirmation_id == "":
            return
        self.busy = True
        self.error = ""
        try:
            res = await http.post(f"{API}/bounties",
                                  {"confirmation_id": self.confirmation_id, "payload": self.sent},
                                  auth=self.token)
            self.posted_link = res.get("id", "")
            self.confirmation_id = ""
            self.sent = {}
            self.notice = "Posted to Bounty."
        except Exception as e:
            # Keep the approval: fix the cause (or approve again) and press Post again.
            self.error = e.message
        self.busy = False

    def build(self):
        if self.token == "":
            return self.no_token()
        else:
            return self.form()

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

    def form(self):
        return Padding(
            ConstrainedBox(
                Column(
                    Text("Post a bounty", variant="heading"),
                    Text("Describe the work. You approve it on Bounty, then post it here.", variant="muted"),
                    Container(
                        Column(
                            Input(TextInput(value=self.title, on_change=self.set_title_text,
                                            placeholder="Fix the lobby sign-in tablet"),
                                  label="Title"),
                            Input(TextInput(value=self.description, on_change=self.set_description,
                                            placeholder="What needs doing and how we will know it is done"),
                                  label="Description"),
                            Select(options=["dev", "design", "content", "marketing", "other"], value=self.category,
                                   on_change=self.set_category, label="Category"),
                            Select(options=["easy", "medium", "hard"], value=self.difficulty,
                                   on_change=self.set_difficulty, label="Difficulty"),
                            Input(TextInput(value=self.reward, on_change=self.set_reward,
                                            placeholder="25000"),
                                  label="Reward (NGN)", hint="Whole naira, up to two decimals"),
                            Input(TextInput(value=self.deadline, on_change=self.set_deadline,
                                            placeholder="2026-11-20T14:00"),
                                  label="Deadline (Lagos time)"),
                            Select(options=["text", "url", "github", "file"], value=self.submission_type,
                                   on_change=self.set_submission_type, label="How work is submitted"),
                            Input(TextInput(value=self.requirements, on_change=self.set_requirements),
                                  label="Requirements (optional)"),
                            Text(self.error, tone="danger", visible=self.error != ""),
                            Text(self.notice, tone="info", visible=self.notice != "" and self.error == ""),
                            Row(
                                Spacer(),
                                self.approve_button(),
                                self.post_button(),
                                gap=8,
                            ),
                            Link("View on Bounty →",
                                 href=f"https://bounty-workpeg.onrender.com/#/bounties/{self.posted_link}",
                                 visible=self.posted_link != ""),
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

    def approve_button(self):
        if self.busy:
            return Button("Working...", disabled=True)
        else:
            return Button("Request approval", variant="outline-gray", on_click=self.request_approval)

    def post_button(self):
        if self.busy or self.confirmation_id == "":
            return Button("Post bounty", disabled=True)
        else:
            return Button("Post bounty", on_click=self.post_bounty)
