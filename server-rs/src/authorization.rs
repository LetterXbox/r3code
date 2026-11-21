//! Scope grants and RPC authorization.
use serde_json::Value;
use std::collections::HashSet;

pub const GRANT_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "providers:manage",
    "environment:maintain",
    "preview:operate",
    "diagnostics:read",
    "terminal:read",
    "terminal:operate",
    "source-control:write",
    "filesystem:read",
    "filesystem:write",
    "access:read",
    "access:write",
    "relay:read",
    "relay:write",
    "relay:configure",
];
pub const LEGACY_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "terminal:operate",
    "review:write",
    "access:read",
    "access:write",
    "relay:read",
    "relay:write",
];

pub const RPC_REQUIRED_SCOPES: &[(&str, &str)] = &[
    ("peerLinks.list", "access:read"),
    ("subscribeAuthAccess", "access:read"),
    ("guestShare.create", "access:write"),
    ("peerLinks.answerRequest", "access:write"),
    ("peerLinks.link", "access:write"),
    ("peerLinks.unlink", "access:write"),
    ("server.getProcessDiagnostics", "diagnostics:read"),
    ("server.getProcessResourceHistory", "diagnostics:read"),
    ("server.getResourceTelemetryHistory", "diagnostics:read"),
    ("server.getTraceDiagnostics", "diagnostics:read"),
    ("server.getUsageSummary", "diagnostics:read"),
    ("server.refreshUsageRates", "diagnostics:read"),
    ("server.retryResourceTelemetry", "diagnostics:read"),
    ("subscribeResourceTelemetry", "diagnostics:read"),
    ("server.commitDesktopUpdate", "environment:maintain"),
    ("server.reclaimDatabaseSpace", "environment:maintain"),
    ("server.signalProcess", "environment:maintain"),
    ("server.updateServer", "environment:maintain"),
    ("server.updateServerWithProgress", "environment:maintain"),
    ("filesystem.browse", "filesystem:read"),
    ("filesystem.getMetadata", "filesystem:read"),
    ("projects.listEntries", "filesystem:read"),
    ("projects.listIgnoredFiles", "filesystem:read"),
    ("projects.readFile", "filesystem:read"),
    ("projects.searchContents", "filesystem:read"),
    ("projects.searchEntries", "filesystem:read"),
    ("review.getBranchCommits", "filesystem:read"),
    ("review.getDiffFileContents", "filesystem:read"),
    ("review.getDiffPreview", "filesystem:read"),
    ("projects.writeFile", "filesystem:write"),
    ("agentSessions.import", "orchestration:operate"),
    ("assets.persistChatAttachments", "orchestration:operate"),
    ("attachments.createUploadUrl", "orchestration:operate"),
    ("attachments.delete", "orchestration:operate"),
    ("device.action", "orchestration:operate"),
    ("device.close", "orchestration:operate"),
    ("device.open", "orchestration:operate"),
    ("device.shutdown", "orchestration:operate"),
    ("mcpApps.callTool", "orchestration:operate"),
    ("mcpApps.updateModelContext", "orchestration:operate"),
    ("orchestration.dispatchCommand", "orchestration:operate"),
    ("orchestration.forceStopThread", "orchestration:operate"),
    ("orchestration.launchThread", "orchestration:operate"),
    ("orchestration.stopWorkflow", "orchestration:operate"),
    ("projects.createFromThread", "orchestration:operate"),
    ("projects.createNew", "orchestration:operate"),
    ("projects.ensureScratch", "orchestration:operate"),
    ("projects.mutate", "orchestration:operate"),
    ("provider.uploadFeedback", "orchestration:operate"),
    ("pullRequests.generateReviewGuide", "orchestration:operate"),
    ("scheduledTasks.delete", "orchestration:operate"),
    ("scheduledTasks.getWebhookDelivery", "orchestration:operate"),
    (
        "scheduledTasks.listWebhookDeliveries",
        "orchestration:operate",
    ),
    ("scheduledTasks.rotateWebhookToken", "orchestration:operate"),
    ("scheduledTasks.runNow", "orchestration:operate"),
    ("scheduledTasks.setEnabled", "orchestration:operate"),
    ("scheduledTasks.upsert", "orchestration:operate"),
    ("secrets.answerRequest", "orchestration:operate"),
    ("server.deleteAcpRegistrySession", "orchestration:operate"),
    ("server.importAcpRegistrySession", "orchestration:operate"),
    ("server.prepareTriage", "orchestration:operate"),
    ("shell.openInEditor", "orchestration:operate"),
    ("worktreeSetup.cancel", "orchestration:operate"),
    ("agentSessions.scan", "orchestration:read"),
    ("assets.createUrl", "orchestration:read"),
    ("device.detail", "orchestration:read"),
    ("device.list", "orchestration:read"),
    ("git.resolvePullRequest", "orchestration:read"),
    ("mcpApps.readResource", "orchestration:read"),
    ("mcpApps.toolInfo", "orchestration:read"),
    (
        "orchestration.getArchivedShellSnapshot",
        "orchestration:read",
    ),
    ("orchestration.getFullThreadDiff", "orchestration:read"),
    ("orchestration.getNativeChildWork", "orchestration:read"),
    ("orchestration.getOlderSettledThreads", "orchestration:read"),
    ("orchestration.getShellSnapshot", "orchestration:read"),
    ("orchestration.getThreadFamily", "orchestration:read"),
    ("orchestration.getThreadLinkMetadata", "orchestration:read"),
    ("orchestration.getThreadProjection", "orchestration:read"),
    ("orchestration.getThreadTitles", "orchestration:read"),
    ("orchestration.getTurnDiff", "orchestration:read"),
    ("orchestration.getTurnItem", "orchestration:read"),
    ("orchestration.getWorkflowScript", "orchestration:read"),
    ("orchestration.getWorktreeThreadIds", "orchestration:read"),
    ("orchestration.searchThread", "orchestration:read"),
    ("orchestration.searchThreadStream", "orchestration:read"),
    ("orchestration.searchThreads", "orchestration:read"),
    ("orchestration.subscribeCommandOutput", "orchestration:read"),
    (
        "orchestration.subscribePromptSuggestion",
        "orchestration:read",
    ),
    ("orchestration.subscribeShell", "orchestration:read"),
    ("orchestration.subscribeThread", "orchestration:read"),
    ("preview.list", "orchestration:read"),
    ("provider.install.subscribe", "orchestration:read"),
    ("issues.candidates", "orchestration:read"),
    ("issues.comments", "orchestration:read"),
    ("issues.detail", "orchestration:read"),
    ("issues.linkedThreads", "orchestration:read"),
    ("issues.list", "orchestration:read"),
    ("issues.templates", "orchestration:read"),
    ("issueTrackers.list", "orchestration:read"),
    ("pullRequests.activity", "orchestration:read"),
    ("pullRequests.changeBreakdown", "orchestration:read"),
    ("pullRequests.checks", "orchestration:read"),
    ("pullRequests.detail", "orchestration:read"),
    ("pullRequests.diffFileContents", "orchestration:read"),
    ("pullRequests.filesViewed", "orchestration:read"),
    ("pullRequests.filterOptions", "orchestration:read"),
    ("pullRequests.invalidate", "orchestration:read"),
    ("pullRequests.labelCandidates", "orchestration:read"),
    ("pullRequests.linkedThreads", "orchestration:read"),
    ("pullRequests.list", "orchestration:read"),
    ("pullRequests.listStats", "orchestration:read"),
    ("pullRequests.preview", "orchestration:read"),
    ("pullRequests.reportState", "orchestration:read"),
    ("pullRequests.reviewGuide", "orchestration:read"),
    ("pullRequests.reviewerCandidates", "orchestration:read"),
    ("pullRequests.routing", "orchestration:read"),
    ("pullRequests.routingIdentity", "orchestration:read"),
    ("pullRequests.stack", "orchestration:read"),
    (
        "pullRequests.subscribeLinkedThreadRefreshes",
        "orchestration:read",
    ),
    ("pullRequests.subscribeRefreshes", "orchestration:read"),
    ("pullRequests.summary", "orchestration:read"),
    ("pullRequests.threadComments", "orchestration:read"),
    ("scheduledTasks.subscribe", "orchestration:read"),
    ("server.discoverSourceControl", "orchestration:read"),
    ("server.getConfig", "orchestration:read"),
    ("server.getDatabaseStorage", "orchestration:read"),
    ("server.getHostResources", "orchestration:read"),
    ("server.getNpmRelease", "orchestration:read"),
    ("server.getStorageCleanupReport", "orchestration:read"),
    ("server.listAcpRegistryProviders", "orchestration:read"),
    ("server.listAcpRegistrySessions", "orchestration:read"),
    ("server.probe", "orchestration:read"),
    ("server.refreshProviders", "orchestration:read"),
    ("server.reportClientActivity", "orchestration:read"),
    ("server.searchAcpRegistry", "orchestration:read"),
    ("sourceControl.appAccess", "orchestration:read"),
    ("sourceControl.lookupRepository", "orchestration:read"),
    ("sourceControl.starred", "orchestration:read"),
    ("subscribeDeviceState", "orchestration:read"),
    ("subscribeDiscoveredLocalServers", "orchestration:read"),
    ("subscribePreviewEvents", "orchestration:read"),
    ("subscribeProjectClones", "orchestration:read"),
    ("subscribeServerConfig", "orchestration:read"),
    ("subscribeServerLifecycle", "orchestration:read"),
    ("subscribeVcsBranch", "orchestration:read"),
    ("subscribeVcsStatus", "orchestration:read"),
    ("subscribeWorktreeSetup", "orchestration:read"),
    ("vcs.listRefs", "orchestration:read"),
    ("vcs.refreshBranch", "orchestration:read"),
    ("vcs.refreshStatus", "orchestration:read"),
    ("preview.adjust", "preview:operate"),
    ("preview.clearProfile", "preview:operate"),
    ("preview.close", "preview:operate"),
    ("preview.open", "preview:operate"),
    ("preview.reportProfiles", "preview:operate"),
    ("preview.reportStatus", "preview:operate"),
    ("preview.resize", "preview:operate"),
    ("provider.auth.cancel", "providers:manage"),
    ("provider.auth.complete", "providers:manage"),
    ("provider.auth.logout", "providers:manage"),
    ("provider.auth.removeMethod", "providers:manage"),
    ("provider.auth.respond", "providers:manage"),
    ("provider.auth.start", "providers:manage"),
    ("provider.auth.subscribe", "providers:manage"),
    ("provider.chatgpt.handoff.subscribe", "providers:manage"),
    ("provider.chatgpt.import-profile", "providers:manage"),
    ("provider.chatgpt.reconnect-profile", "providers:manage"),
    ("provider.consumeResetCredit", "providers:manage"),
    ("provider.install.cancel", "providers:manage"),
    ("provider.install.remove", "providers:manage"),
    ("provider.install.start", "providers:manage"),
    ("server.acceptAcpRegistryUrlAuth", "providers:manage"),
    ("server.disableAcpRegistryProvider", "providers:manage"),
    ("server.logoutAcpRegistry", "providers:manage"),
    ("server.prepareAcpRegistryAgent", "providers:manage"),
    ("server.setAcpRegistryProvider", "providers:manage"),
    (
        "server.uninstallAcpRegistryManagedBinary",
        "providers:manage",
    ),
    ("server.updateProvider", "providers:manage"),
    ("cloud.getRelayClientStatus", "relay:read"),
    ("cloud.installRelayClient", "relay:write"),
    ("device.configure", "settings:write"),
    ("device.easAccount", "settings:write"),
    ("device.simlockIdentity", "settings:write"),
    ("device.testHost", "settings:write"),
    ("issueTrackers.bindProject", "settings:write"),
    ("issueTrackers.connect", "settings:write"),
    ("server.checkOtlpEndpoint", "settings:write"),
    ("server.checkSecretSource", "settings:write"),
    ("server.listTextGeneratorModels", "settings:write"),
    ("server.removeKeybinding", "settings:write"),
    ("server.runStorageCleanup", "settings:write"),
    ("server.updateSettings", "settings:write"),
    ("server.upsertKeybinding", "settings:write"),
    ("sourceControl.signInCancel", "settings:write"),
    ("sourceControl.signInStart", "settings:write"),
    ("sourceControl.signInWait", "settings:write"),
    ("git.preparePullRequestThread", "source-control:write"),
    ("git.runStackedAction", "source-control:write"),
    ("issues.comment", "source-control:write"),
    ("issues.create", "source-control:write"),
    ("issues.react", "source-control:write"),
    ("issues.setState", "source-control:write"),
    ("issues.update", "source-control:write"),
    ("projectClone.cancel", "source-control:write"),
    ("projectClone.retry", "source-control:write"),
    ("projectClone.start", "source-control:write"),
    ("pullRequests.comment", "source-control:write"),
    ("pullRequests.replyToThread", "source-control:write"),
    ("pullRequests.requestReviewers", "source-control:write"),
    ("pullRequests.runAction", "source-control:write"),
    ("pullRequests.setFilesViewed", "source-control:write"),
    ("pullRequests.setLabels", "source-control:write"),
    ("pullRequests.setReaction", "source-control:write"),
    ("pullRequests.setThreadResolution", "source-control:write"),
    ("pullRequests.submitReview", "source-control:write"),
    ("pullRequests.update", "source-control:write"),
    ("pullRequests.updateComment", "source-control:write"),
    ("sourceControl.cloneRepository", "source-control:write"),
    ("sourceControl.publishRepository", "source-control:write"),
    ("sourceControl.star", "source-control:write"),
    ("vcs.createRef", "source-control:write"),
    ("vcs.createWorktree", "source-control:write"),
    ("vcs.init", "source-control:write"),
    ("vcs.pull", "source-control:write"),
    ("vcs.removeWorktree", "source-control:write"),
    ("vcs.switchRef", "source-control:write"),
    ("preview.stopLocalServer", "terminal:operate"),
    ("terminal.attach", "terminal:operate"),
    ("terminal.clear", "terminal:operate"),
    ("terminal.close", "terminal:operate"),
    ("terminal.open", "terminal:operate"),
    ("terminal.resize", "terminal:operate"),
    ("terminal.write", "terminal:operate"),
    ("subscribeTerminalMetadata", "terminal:read"),
    ("terminal.observe", "terminal:read"),
];

/// Legacy scopes are a filtered representation of a grant, never an expansion.
pub fn legacy_scopes(grant: &[String]) -> Vec<&str> {
    grant
        .iter()
        .map(String::as_str)
        .filter(|s| LEGACY_SCOPES.contains(s))
        .collect()
}
pub fn legacy_parent(scope: &str) -> &str {
    match scope {
        "filesystem:read" | "diagnostics:read" => "orchestration:read",
        "settings:write"
        | "providers:manage"
        | "environment:maintain"
        | "preview:operate"
        | "source-control:write"
        | "filesystem:write" => "orchestration:operate",
        "terminal:read" => "terminal:operate",
        "relay:configure" => "relay:write",
        _ => scope,
    }
}
/// Token exchange discards unknown and retired names; the caller must reject an empty result.
pub fn recognized_grants<'a>(requested: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    requested
        .into_iter()
        .filter(|s| GRANT_SCOPES.contains(s))
        .collect()
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingScope {
    pub required_scope: String,
    pub required_permission: String,
}
pub fn first_missing(granted: &HashSet<String>, required: &[&str]) -> Option<MissingScope> {
    required
        .iter()
        .find(|scope| !granted.contains(**scope))
        .map(|scope| MissingScope {
            required_scope: legacy_parent(scope).to_string(),
            required_permission: (*scope).to_string(),
        })
}
/// Checks access:write first, then each delegated permission in request order.
pub fn check_delegation(granted: &HashSet<String>, delegated: &[&str]) -> Result<(), MissingScope> {
    let mut needed = vec!["access:write"];
    needed.extend_from_slice(delegated);
    match first_missing(granted, &needed) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationRuleError {
    UnknownMethod,
    InvalidPayload,
}

fn contains_secret_reference(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if map.get("provider").and_then(Value::as_str).is_some()
                && map.get("reference").and_then(Value::as_str).is_some()
            {
                return true;
            }
            map.values().any(contains_secret_reference)
        }
        Value::Array(items) => items.iter().any(contains_secret_reference),
        _ => false,
    }
}

/// Call only after decoding the method payload against its full schema. This function
/// checks the fields needed by authorization, but does not replace schema validation.
pub fn required_scopes_for_rpc(
    method: &str,
    payload: &Value,
) -> Result<Vec<&'static str>, AuthorizationRuleError> {
    let base = RPC_REQUIRED_SCOPES
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, scope)| *scope)
        .ok_or(AuthorizationRuleError::UnknownMethod)?;
    let object = || {
        payload
            .as_object()
            .ok_or(AuthorizationRuleError::InvalidPayload)
    };
    match method {
        "server.updateSettings" => {
            let data = object()?;
            let patch = data
                .get("patch")
                .and_then(Value::as_object)
                .ok_or(AuthorizationRuleError::InvalidPayload)?;
            let providers = [
                "providers",
                "providerInstances",
                "usageLimitSources",
                "textGenerators",
                "secretProviders",
            ];
            let access = ["requireConnectDeviceApproval", "enablePreviewTunnel"];
            let mut changes_providers =
                patch.keys().any(|key| providers.contains(&key.as_str()));
            let changes_access = patch.keys().any(|key| access.contains(&key.as_str()));
            let mut changes_settings = patch
                .keys()
                .any(|key| !providers.contains(&key.as_str()) && !access.contains(&key.as_str()));
            if contains_secret_reference(data.get("patch").unwrap_or(&Value::Null)) {
                changes_providers = true;
            }
            if let Some(secret) = patch.get("secretProviders") {
                let entries = secret
                    .as_object()
                    .ok_or(AuthorizationRuleError::InvalidPayload)?;
                changes_settings |= entries.values().any(Value::is_null);
            }
            let mutation = data.get("providerInstanceMutation").is_some();
            let mut required = Vec::new();
            if changes_settings || (!changes_providers && !changes_access && !mutation) {
                required.push("settings:write");
            }
            if changes_providers || mutation {
                required.push("providers:manage");
            }
            if changes_access {
                required.push("access:write");
            }
            Ok(required)
        }
        "projects.mutate" => {
            let data = object()?;
            let kind = data
                .get("type")
                .and_then(Value::as_str)
                .ok_or(AuthorizationRuleError::InvalidPayload)?;
            if !["project.create", "project.update", "project.delete"].contains(&kind) {
                return Err(AuthorizationRuleError::InvalidPayload);
            }
            let mut required = vec![base];
            if kind != "project.delete" && data.contains_key("scripts") {
                required.push("settings:write");
            }
            Ok(required)
        }
        "assets.createUrl" => {
            let resource = object()?
                .get("resource")
                .and_then(Value::as_object)
                .ok_or(AuthorizationRuleError::InvalidPayload)?;
            let tag = resource
                .get("_tag")
                .and_then(Value::as_str)
                .ok_or(AuthorizationRuleError::InvalidPayload)?;
            let needs_files = ["workspace-file", "media-file", "draft-workspace-file"]
                .contains(&tag)
                || (tag == "native-app-icon"
                    && resource
                        .get("app")
                        .and_then(|a| a.get("_tag"))
                        .and_then(Value::as_str)
                        == Some("app-path"));
            Ok(vec![if needs_files { "filesystem:read" } else { base }])
        }
        "server.retryResourceTelemetry" => Ok(vec!["environment:maintain", "diagnostics:read"]),
        "git.preparePullRequestThread" => {
            let data = object()?;
            let mut required = vec![base];
            if data.get("mode").and_then(Value::as_str) == Some("worktree")
                && data.get("threadId").is_some_and(|v| !v.is_null())
            {
                required.push("orchestration:operate");
            }
            Ok(required)
        }
        "git.runStackedAction" => {
            let data = object()?;
            let mut required = vec![base];
            if data.get("threadId").is_some_and(|v| !v.is_null())
                && matches!(
                    data.get("action").and_then(Value::as_str),
                    Some("create_pr" | "commit_push_pr")
                )
            {
                required.push("orchestration:read");
            }
            Ok(required)
        }
        "device.list" => {
            let data = object()?;
            Ok(vec![if ["retryHostId", "updateTool"]
                .iter()
                .any(|key| data.get(*key).is_some_and(|v| !v.is_null()))
            {
                "orchestration:operate"
            } else {
                base
            }])
        }
        "orchestration.dispatchCommand" => {
            let data = object()?;
            let mut required = vec![base];
            let is_signout = |text: Option<&str>, attachments: Option<&Value>| {
                text.is_some_and(|s| s.trim().eq_ignore_ascii_case("/logout"))
                    && attachments
                        .and_then(Value::as_array)
                        .is_none_or(|arr| arr.is_empty())
            };
            let needs_manage = match data.get("type").and_then(Value::as_str) {
                Some("message.dispatch") => {
                    is_signout(data.get("text").and_then(Value::as_str), data.get("attachments"))
                }
                Some("queued-run.edit") => {
                    data.get("attachments").is_some()
                        && is_signout(
                            data.get("text").and_then(Value::as_str),
                            data.get("attachments"),
                        )
                }
                Some("delegated_task.request") => {
                    is_signout(data.get("task").and_then(Value::as_str), None)
                }
                _ => false,
            };
            if needs_manage {
                required.push("providers:manage");
            }
            Ok(required)
        }
        "orchestration.launchThread" => {
            let data = object()?;
            let mut required = vec![base];
            if let Some(msg) = data.get("initialMessage").and_then(Value::as_object) {
                let text = msg.get("text").and_then(Value::as_str);
                let empty_attachments = msg
                    .get("attachments")
                    .and_then(Value::as_array)
                    .is_none_or(|a| a.is_empty());
                if empty_attachments
                    && text.is_some_and(|s| s.trim().eq_ignore_ascii_case("/logout"))
                {
                    required.push("providers:manage");
                }
            }
            Ok(required)
        }
        _ => Ok(vec![base]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn catalog_is_unique_and_complete() {
        let methods: HashSet<_> = RPC_REQUIRED_SCOPES.iter().map(|(m, _)| m).collect();
        assert_eq!(methods.len(), 235);
        assert!(RPC_REQUIRED_SCOPES
            .iter()
            .all(|(_, scope)| GRANT_SCOPES.contains(scope)));
        assert_eq!(
            required_scopes_for_rpc("unknown", &json!({})),
            Err(AuthorizationRuleError::UnknownMethod)
        );
    }
    #[test]
    fn grants_never_expand_legacy_parents() {
        let granted = HashSet::from(["orchestration:operate".to_owned()]);
        assert_eq!(
            first_missing(&granted, &["settings:write"]).unwrap(),
            MissingScope {
                required_scope: "orchestration:operate".into(),
                required_permission: "settings:write".into()
            }
        );
        assert_eq!(
            recognized_grants(["review:write", "invalid", "access:read"]),
            vec!["access:read"]
        );
    }
    #[test]
    fn dynamic_rules_include_combined_requirements() {
        assert_eq!(
            required_scopes_for_rpc(
                "server.updateSettings",
                &json!({"patch":{"secretProviders":{"a":null}}})
            )
            .unwrap(),
            vec!["settings:write", "providers:manage"]
        );
        assert_eq!(
            required_scopes_for_rpc(
                "server.updateSettings",
                &json!({"patch":{},"providerInstanceMutation":{}})
            )
            .unwrap(),
            vec!["providers:manage"]
        );
        assert_eq!(
            required_scopes_for_rpc(
                "projects.mutate",
                &json!({"type":"project.update","scripts":[]})
            )
            .unwrap(),
            vec!["orchestration:operate", "settings:write"]
        );
        assert_eq!(
            required_scopes_for_rpc(
                "assets.createUrl",
                &json!({"resource":{"_tag":"native-app-icon","app":{"_tag":"app-path"}}})
            )
            .unwrap(),
            vec!["filesystem:read"]
        );
        assert_eq!(
            required_scopes_for_rpc("server.retryResourceTelemetry", &json!({})).unwrap(),
            vec!["environment:maintain", "diagnostics:read"]
        );
        assert_eq!(
            required_scopes_for_rpc("device.list", &json!({"retryHostId":"host"})).unwrap(),
            vec!["orchestration:operate"]
        );
        assert_eq!(
            required_scopes_for_rpc(
                "server.updateSettings",
                &json!({"patch":{"enablePreviewTunnel":false}})
            )
            .unwrap(),
            vec!["access:write"]
        );
        assert_eq!(
            required_scopes_for_rpc(
                "server.updateSettings",
                &json!({"patch":{"sourceControlHosts":{"github":{"token":{"provider":"one_password","reference":"op://x/y"}}}}})
            )
            .unwrap(),
            vec!["settings:write", "providers:manage"]
        );
        assert_eq!(legacy_parent("relay:configure"), "relay:write");
    }
}
