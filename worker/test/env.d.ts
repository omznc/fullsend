import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as FullsendEnv } from "../src/env";
import type * as FullsendModule from "../src/index";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof FullsendModule;
    }

    interface Env extends FullsendEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
