"""Reusable pieces every page draws its states with.

A group of widgets used twice becomes a Component here, so a page never
copies a style dict. Each one is built from the SDK's own widgets, variants
and tokens: change the look by changing a variant, not by adding style=.
"""
from workpeg.ui import (
    Component, Center, Column, Container, Expanded, Icon, Row, Spinner, Tag,
    Text,
)


class PageHeader(Component):
    """A page's title, one line under it, and its single action."""

    def __init__(self, title, subtitle, action):
        self.title = title
        self.subtitle = subtitle
        self.action = action

    def build(self):
        return Row(
            Expanded(
                Column(
                    Text(self.title, variant="heading"),
                    Text(self.subtitle, variant="muted"),
                    gap=4,
                ),
            ),
            self.action,
            align="center", gap=16,
        )


class LoadingState(Component):
    """While a page waits for its first answer."""

    def __init__(self, label):
        self.label = label

    def build(self):
        return Center(
            Column(
                Spinner(size=24),
                Text(self.label, variant="muted"),
                gap=16, align="center",
            ),
        )


class EmptyState(Component):
    """Nothing here yet: an icon, a line, a hint and one action."""

    def __init__(self, icon, title, detail, action):
        self.icon = icon
        self.title = title
        self.detail = detail
        self.action = action

    def build(self):
        return Container(
            Column(
                Icon(self.icon, size=32),
                Text(self.title, weight="semibold"),
                Text(self.detail, variant="muted"),
                self.action,
                gap=8, align="center",
            ),
            variant="card", padding=40,
        )


class ErrorState(Component):
    """A read failed: say what the server said and offer a way on."""

    def __init__(self, message, action):
        self.message = message
        self.action = action

    def build(self):
        return Container(
            Column(
                Icon("alert-triangle", size=32),
                Text("Something went wrong", weight="semibold"),
                Text(self.message, tone="danger"),
                self.action,
                gap=8, align="center",
            ),
            variant="card", padding=40,
        )


class BountyRow(Component):
    """One open bounty from Bounty: title, what it is, reward, due and status."""

    def __init__(self, title, meta, reward, due, status):
        self.title = title
        self.meta = meta
        self.reward = reward
        self.due = due
        self.status = status

    def build(self):
        return Container(
            Column(
                Row(
                    Expanded(
                        Column(
                            Text(self.title, weight="semibold"),
                            Text(self.meta, variant="caption"),
                            gap=4,
                        ),
                    ),
                    BountyStatusTag(self.status),
                    align="center", gap=16,
                ),
                Text(f"{self.reward} · {self.due}", variant="muted"),
                gap=8,
            ),
            variant="card", padding=24,
        )


class BountyStatusTag(Component):
    """A bounty's status as a labelled, toned Tag.

    Tag(tone=) takes a literal, so each status is its own branch.
    """

    def __init__(self, status):
        self.status = status

    def build(self):
        if self.status == "submitted":
            return Tag("Submitted", tone="info", dot=True)
        elif self.status == "approved":
            return Tag("Approved", tone="success", dot=True)
        elif self.status == "closed":
            return Tag("Closed", tone="neutral", dot=True)
        else:
            return Tag("Open", tone="info", dot=True)


class SubmissionStatusTag(Component):
    """A submission's review state as a labelled, toned Tag."""

    def __init__(self, status):
        self.status = status

    def build(self):
        if self.status == "approved":
            return Tag("Approved", tone="success", dot=True)
        elif self.status == "rejected":
            return Tag("Rejected", tone="neutral", dot=True)
        else:
            return Tag("Pending", tone="info", dot=True)
