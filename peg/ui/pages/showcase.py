"""The showcase page. Sample data only: no Workpeg table is read or written yet."""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, Expanded, Text, set_title, store,
)


class ShowcasePage(App):
    tasks = State([
        {"title": "Translate the onboarding guide", "category": "Writing", "reward": "$250",
         "deadline": "1 Dec 2026", "status": "Open",
         "summary": "Translate our onboarding guide into French. Keep the headings and links."},
        {"title": "Photograph the spring menu", "category": "Photography", "reward": "$180",
         "deadline": "20 Nov 2026", "status": "In progress",
         "summary": "Eight dishes, natural light, two angles each. Files as JPG at full size."},
        {"title": "Audit the checkout flow", "category": "Testing", "reward": "$400",
         "deadline": "5 Dec 2026", "status": "Under review",
         "summary": "Walk through the checkout on mobile and desktop, then list every problem found."},
    ])

    def on_mount(self):
        store.page_title = "Showcase"
        set_title("Showcase")

    def build(self):
        return Padding(
            Column(
                Column(
                    Text("Public showcase", variant="heading"),
                    Text("Tasks that businesses have chosen to make public.", variant="muted"),
                    gap=4,
                ),
                Text("Sample data for the demo. Live data is not connected yet.", variant="caption"),
                *[
                    Container(
                        Column(
                            Row(
                                Expanded(Text(t["title"], variant="heading")),
                                Text(t["reward"], weight="semibold"),
                                gap=16, align="center",
                            ),
                            Text(t["category"] + " · due " + t["deadline"] + " · " + t["status"],
                                 variant="caption"),
                            Text(t["summary"]),
                            gap=8, align="start",
                        ),
                        variant="card", padding=24,
                    )
                    for t in self.tasks
                ],
                gap=24,
            ),
            all=24,
        )
