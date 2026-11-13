"""The chrome. Scaffold draws sign-in, the rail, Search, Workpeg AI, the
business switcher, the top bar and the phone layout; this file only fills
its slots. Add a page's NavItem here when you add its Route in main.py."""
from workpeg.ui import Shell, Outlet, Text, biz_url, set_color_scheme, store
from workpeg.ui.scaffold import Scaffold, NavItem, NavSection, NavFixed


class AppShell(Shell):

    async def on_mount(self):
        # Follow the device's light or dark setting, live.
        set_color_scheme("system")

    def build(self):
        return Scaffold(
            NavSection(
                "Work",
                NavItem("Services", biz_url("/services"), icon="tool"),
            ),
            fixed=NavFixed(NavItem("Home", biz_url("/"), icon="home")),
            top_nav=Text(store.page_title, weight="semibold"),
            main=Outlet(),
        )
