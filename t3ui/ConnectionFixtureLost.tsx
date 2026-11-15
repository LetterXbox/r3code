// The full app on a live, used workspace whose connection then drops: reconnecting first (the status goes back to connecting),
// then failing (error). The session credential exists in a real connection, so the coordinator is told it does.
import "./FirstRunSeedUsed";
import { forceConnectionSessionForTest } from "./components/coordinators/connectionCoordinator";
import { setBackendStatusForTest } from "./store";
import "./App";

forceConnectionSessionForTest(true);
// Two seconds after the first frame: the connection drops, the way the socket's close handler moves the store to connecting.
setTimeout(() => setBackendStatusForTest("connecting"), 400);
setTimeout(() => setBackendStatusForTest("error"), 4500);
setTimeout(() => setBackendStatusForTest("connected"), 9000);
