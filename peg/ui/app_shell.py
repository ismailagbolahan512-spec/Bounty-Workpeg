"""The chrome. Scaffold draws sign-in, the rail, Search, Workpeg AI, the business switcher,
the top bar and the phone layout; this file only fills its slots."""
from workpeg.ui import Shell, Outlet, Text, biz_url, set_color_scheme, store
from workpeg.ui.scaffold import Scaffold, NavItem, NavSection


class AppShell(Shell):

    async def on_mount(self):
        set_color_scheme("system")

    def build(self):
        return Scaffold(
            NavSection(
                "Public",
                NavItem("Showcase", biz_url("/"), icon="clipboard"),
            ),
            top_nav=Text(store.page_title, weight="semibold"),
            main=Outlet(),
        )
