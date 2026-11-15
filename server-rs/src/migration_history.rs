//! Migration ledger validation. Schema application and preview reconciliation remain separate.
use std::collections::HashMap;

pub const MANIFEST: &[(i64, &str)] = &[
    (1, "OrchestrationEvents"),
    (2, "OrchestrationCommandReceipts"),
    (3, "CheckpointDiffBlobs"),
    (4, "ProviderSessionRuntime"),
    (5, "Projections"),
    (6, "ProjectionThreadSessionRuntimeModeColumns"),
    (7, "ProjectionThreadMessageAttachments"),
    (8, "ProjectionThreadActivitySequence"),
    (9, "ProviderSessionRuntimeMode"),
    (10, "ProjectionThreadsRuntimeMode"),
    (11, "OrchestrationThreadCreatedRuntimeMode"),
    (12, "ProjectionThreadsInteractionMode"),
    (13, "ProjectionThreadProposedPlans"),
    (14, "ProjectionThreadProposedPlanImplementation"),
    (15, "ProjectionTurnsSourceProposedPlan"),
    (16, "CanonicalizeModelSelections"),
    (17, "ProjectionThreadsArchivedAt"),
    (18, "ProjectionThreadsArchivedAtIndex"),
    (19, "ProjectionSnapshotLookupIndexes"),
    (20, "AuthAccessManagement"),
    (21, "AuthSessionClientMetadata"),
    (22, "AuthSessionLastConnectedAt"),
    (23, "ProjectionThreadShellSummary"),
    (24, "BackfillProjectionThreadShellSummary"),
    (25, "CleanupInvalidProjectionPendingApprovals"),
    (26, "CanonicalizeModelSelectionOptions"),
    (27, "ProviderSessionRuntimeInstanceId"),
    (28, "ProjectionThreadSessionInstanceId"),
    (29, "ProjectionThreadDetailOrderingIndexes"),
    (30, "ProjectionThreadShellArchiveIndexes"),
    (31, "AuthAuthorizationScopes"),
    (32, "AuthPairingProofKeyThumbprint"),
    (33, "ProjectionThreadsSettled"),
    (34, "ProjectionThreadsSnoozed"),
    (35, "ProjectionThreadTitleRegeneration"),
    (36, "ProjectionThreadsPinned"),
    (37, "ProjectionTurnsKeysetIndex"),
    (38, "ProjectionThreadsPinOrderKey"),
    (39, "ProjectionProjectsDefaultThreadEnvMode"),
    (40, "ProjectionProjectFaviconPath"),
    (41, "AuthSessionClientConnection"),
    (42, "ProjectionThreadLinkedPullRequest"),
    (43, "ProjectionThreadsUnsettledAt"),
    (44, "ClearAutomaticProjectModelDefaults"),
    (45, "ProjectionProjectsAutoPull"),
    (46, "RepairAutomaticSettlementTimestamps"),
    (47, "ProjectionProjectIcon"),
    (48, "ProjectionThreadBranchPullRequest"),
    (49, "ProjectionThreadsActiveOrderKey"),
    (50, "ProjectionThreadPullRequests"),
    (51, "ProjectionThreadMessageContext"),
    (52, "ProjectionThreadTitleState"),
    (53, "PullRequestFilesViewed"),
    (54, "ProjectionThreadsAutoSettleDisabledAt"),
    (55, "OrchestrationV2"),
    (56, "RemoveRedundantProjectionIndexes"),
    (57, "ScheduledTaskWebhooks"),
    (58, "WebhookRelayDeliveries"),
    (59, "McpAppModelContext"),
    (60, "ThreadSnapshotWindowIndexes"),
    (61, "PullRequestReviewGuides"),
    (62, "ThreadFailureLookupIndex"),
    (63, "DropUnusedV1Projections"),
    (64, "CanonicalizeThreadPullRequestLinks"),
    (65, "CodexUsageNativeTurnIndex"),
    (66, "RepairClientSettlementTimestamps"),
    (67, "WebhookDedupe"),
    (68, "ShellStopRequestIndex"),
    (69, "ThreadMessageSearch"),
    (70, "PeerLinks"),
    (71, "PeerLinkFence"),
    (72, "WaitingLinkRequestIndex"),
    (73, "ActiveTurnItemIndexes"),
    (74, "ExcludeAttachmentPlaceholdersFromSearch"),
    (75, "SubagentDeliveryState"),
    (76, "ProjectionProjectsPinArchive"),
    (77, "RepairBooleanSettledOverride"),
    (78, "DropOrchestrationEventCorrelationIndex"),
    (79, "DelegatedRecoveryIndexes"),
    (80, "ScheduledTaskThreadMode"),
    (81, "ProjectionMessageSearchText"),
    (82, "TurnItemConversationIndex"),
    (83, "CommandReadIndexes"),
    (84, "LastExecutedRunIndex"),
    (85, "TurnItemCounts"),
    (86, "QueuedTurnInputIndex"),
    (87, "ProjectionProjectsCustomTitle"),
    (88, "TurnItemTypeStatusIndex"),
    (89, "ShellThreadReadIndexes"),
];

/// Report V2 migrations that an id-only migrator would silently skip.
/// Reconcile legacy preview migrations before invoking this guard.
pub fn skipped_v2(recorded: &[(i64, String)], through: Option<i64>) -> Vec<String> {
    let latest = recorded.iter().map(|(id, _)| *id).max().unwrap_or(0);
    let names: HashMap<i64, &str> = recorded
        .iter()
        .map(|(id, name)| (*id, name.as_str()))
        .collect();
    MANIFEST
        .iter()
        .filter_map(|(id, name)| {
            if *id < 55 || *id > latest || through.is_some_and(|limit| *id > limit) {
                return None;
            }
            match names.get(id) {
                Some(actual) if actual == name => None,
                actual => Some(format!(
                    "{}_{} (recorded: {})",
                    id,
                    name,
                    actual.copied().unwrap_or("nothing")
                )),
            }
        })
        .collect()
}

pub fn has_pending(recorded: &[(i64, String)]) -> bool {
    recorded.iter().map(|(id, _)| *id).max().unwrap_or(0) < 89
        || recorded
            .iter()
            .any(|(id, name)| (*id == 53 || *id == 54) && name == "OrchestrationV2")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protects_against_skipped_or_renamed_v2_migrations() {
        let mut rows: Vec<_> = MANIFEST
            .iter()
            .take(57)
            .map(|(id, name)| (*id, name.to_string()))
            .collect();
        assert!(skipped_v2(&rows, None).is_empty());
        rows.retain(|(id, _)| *id != 56);
        rows.iter_mut().find(|(id, _)| *id == 57).unwrap().1 = "Other".into();
        assert_eq!(
            skipped_v2(&rows, None),
            vec![
                "56_RemoveRedundantProjectionIndexes (recorded: nothing)",
                "57_ScheduledTaskWebhooks (recorded: Other)"
            ]
        );
        assert_eq!(skipped_v2(&rows, Some(55)), Vec::<String>::new());
        assert!(has_pending(&rows));
        assert!(!has_pending(
            &MANIFEST
                .iter()
                .map(|(id, name)| (*id, name.to_string()))
                .collect::<Vec<_>>()
        ));
        assert!(has_pending(&[
            (89, "ShellThreadReadIndexes".into()),
            (53, "OrchestrationV2".into())
        ]));
    }
}
