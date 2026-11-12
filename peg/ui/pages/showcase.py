"""The showcase page. Sample data only: no Workpeg table is read or written yet."""
from workpeg.ui import (
    App, State, Padding, Column, Row, Container, Expanded, Text, set_title, store,
)


class ShowcasePage(App):
    tasks = State([
        {"title": "Audit the housekeeping checklist on three floors", "category": "Hotel operations",
         "reward": "$300", "deadline": "1 Dec 2026", "status": "Open",
         "summary": "Walk three floors with the checklist. Note every missed step, with a photo."},
        {"title": "Photograph the spring tasting menu", "category": "Restaurant",
         "reward": "$180", "deadline": "20 Nov 2026", "status": "In progress",
         "summary": "Eight dishes, natural light, two angles each. Full-size JPG files."},
        {"title": "Mystery-guest review of breakfast service", "category": "Guest experience",
         "reward": "$220", "deadline": "5 Dec 2026", "status": "Under review",
         "summary": "Visit at 8am on two weekdays. Time the service, and report on the buffet and greetings."},
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
