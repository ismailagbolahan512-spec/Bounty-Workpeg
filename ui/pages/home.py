from workpeg.ui import (
    App, Padding, Column, Row, Container, Expanded, Text, Button, Icon,
    biz_url, navigate, set_title, store,
)


class HomePage(App):
    def on_mount(self):
        store.page_title = "Home"
        set_title("Home")

    def open_services(self):
        navigate(biz_url("/services"))

    def build(self):
        return Padding(
            Column(
                Column(
                    Text(f"Welcome to {store.business}", variant="heading"),
                    Text("Link your Bounty account to see your hospitality requests, quotes and visits.",
                         variant="muted"),
                    gap=4,
                ),
                Container(
                    Row(
                        Icon("tool", size=24),
                        Expanded(
                            Column(
                                Text("Hospitality services", weight="semibold"),
                                Text("Your open requests, the quotes you have received, and your scheduled visits.",
                                     variant="caption"),
                                gap=4,
                            ),
                        ),
                        Button("Open", variant="outline-gray",
                               icon="arrow-right", icon_position="right",
                               on_click=self.open_services),
                        align="center", gap=16,
                    ),
                    variant="card", padding=24,
                ),
                gap=24,
            ),
            all=24,
        )
