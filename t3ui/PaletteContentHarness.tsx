// PaletteHarness with a session that may read files: content search needs filesystem:read (resolveFilesystemReadAccess).
import "./PaletteHarness";
import { FILESYSTEM_READ_SCOPE, overrideSessionScope } from "./backend/sessionScopes";

overrideSessionScope(FILESYSTEM_READ_SCOPE, "granted");
