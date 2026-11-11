from workpeg.ui import (
    App, Padding, Column, Row, Container, Expanded, Text, Button, Icon,
    biz_url, navigate, set_title, store,
)


class HomePage(App):
    def on_mount(self):
        store.page_title = "Home"
        set_title("Home")

    def open_bounties(self):
        navigate(biz_url("/bounties"))

    def build(self):
        return Padding(
            Column(
                Column(
                    Text(f"Welcome to {store.business}", variant="heading"),
                    Text("Post small jobs and review the work people send back.",
                         variant="muted"),
                    gap=4,
                ),
                Container(
                    Row(
                        Icon("clipboard", size=24),
                        Expanded(
                            Column(
                                Text("Bounties", weight="semibold"),
                                Text("Open jobs, submitted work and approvals.",
                                     variant="caption"),
                                gap=4,
                            ),
                        ),
                        Button("Open", variant="outline-gray",
                               icon="arrow-right", icon_position="right",
                               on_click=self.open_bounties),
                        align="center", gap=16,
                    ),
                    variant="card", padding=24,
                ),
                gap=24,
            ),
            all=24,
        )
