# Attribution

Autoroute is original code. No source was copied from other projects. Ideas were reviewed in these MIT-licensed projects, at the listed revisions:

- alexei-led/claude-router `3edad1c70caecad529f1ab3886b57c74c3487686`: request-level routing and keeping requested and answered models apart.
- alexei-led/codex-router `dccc147478ccfe8407005f6eae0b872e25e795eb`: overall architecture (its proxy approach was not used).
- mralexivy/AutoMode `d09ae51038b1972320eb1a4677ed01fcbdee82d3`: risk and pin test scenarios.
- HeyCubit/effortless `e5c590dfd9402244ea66a8bf795d1cb86d1df7b9`: evaluating the cost of switching models with a warm cache.
- luckeyfaraday/auto-reasoning `a70c7c4274391cad2fa298db0f11fbc1eba2c469`: raising effort after failed verification.
- duolahypercho/codex-router `8d1ea9f0e5873b2a8f5d72b07c7f0df7a328ea5d`: service lifecycle and diagnostics.

Build tools (TypeScript, Apache-2.0; esbuild, MIT; @types/node, MIT) are development dependencies only. The installed package has no runtime dependencies. The dashboard icons for the theme switch are from [Lucide](https://lucide.dev) (ISC license).

Lucide icons: ISC License, Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
