//! Foundations for the Rust T3 Code server implementation.
//!
//! The transport, migrations, and orchestration are not yet complete.
mod agent_session_import;
pub mod agent_awareness_relay;
pub mod agent_session_scan;
pub mod background_activity;
mod keep_awake;
pub mod checkpoint;
pub mod cloud_connector;
pub(crate) mod cloud_link_config;
pub(crate) mod cloud_link_key;
pub(crate) mod cloud_reachability;
pub mod context_handoff;
mod conversation_provider;
mod command_output;
mod terminal_output;
pub mod database;
pub mod database_maintenance;
pub mod database_storage;
pub mod delegated_ack;
pub mod delegated_cancel;
pub mod delegated_cleanup;
pub mod delegated_continuation;
pub mod delegated_create;
pub mod delegated_result;
pub mod delegated_settlement;
pub mod delegated_worker;
pub mod delegated_worktree;
pub mod environment_theme;
pub mod event_store;
pub mod image_dimensions;
pub mod legacy_database_snapshot;
pub mod mcp_app_html;
pub mod mcp_capabilities;
pub mod mcp_credentials;
pub(crate) mod mcp_client_auth;
pub mod mcp_delegate;
pub mod mcp_delegate_wait;
pub mod mcp_http;
pub(crate) mod mcp_oauth;
pub(crate) mod mcp_oauth_http;
pub mod mcp_projects;
pub mod mcp_queue;
pub mod mcp_scheduled;
pub mod mcp_task_cancel;
pub mod mcp_task_status;
pub mod mcp_thread_configure;
pub mod mcp_thread_interrupt;
pub mod mcp_thread_launch;
pub mod mcp_workflow;
pub mod mcp_thread_organize;
pub mod mcp_thread_read;
pub mod mcp_thread_read_ack;
pub mod mcp_thread_search;
pub mod mcp_thread_send;
pub mod mcp_thread_transfer;
pub mod mcp_thread_update;
pub mod mcp_thread_wait;
pub mod merge_commands;
pub mod merge_handoff;
pub mod resource_telemetry;
pub mod message_commands;
pub mod migration_history;
pub mod npm_release;
pub mod otlp_check;
pub mod otlp_http;
mod otlp_trace;
mod peer_link_requests;
mod peer_links;
pub(crate) mod peer_mcp;
mod project_clone_tracker;
pub mod review_diff;
mod scratch_project;
mod scratch_promotion;
pub mod source_control_clone;
pub mod source_control_discovery;
pub mod source_control_lookup;
pub mod source_control_publish;
pub(crate) mod source_control_signin;
pub mod thread_launch;
pub mod thread_settlement_service;
pub mod triage;
pub mod usage_aggregation;
pub mod usage_limit_sources;
pub mod usage_pricing;
pub mod usage_service;
pub mod workspace_safety;

pub mod acp_mcp_bridge;
pub mod application;
pub mod attachment_asset;
pub mod attachment_http;
pub mod attachment_paths;
pub mod attachment_store;
pub mod auth;
pub mod auth_access;
pub mod auth_http;
pub mod authorization;
pub mod background_work;
pub mod bootstrap;
pub mod codec;
pub mod composer_context;
pub mod config;
pub mod direct_endpoints;
pub mod document_text;
pub mod dpop;
pub mod editor;
pub mod effect_worker;
pub mod event_bus;
pub mod fork_commands;
pub mod host_resources;
pub mod http_server;
pub mod interrupt_commands;
pub mod keybindings;
pub mod legacy_shells;
pub mod legacy_transcript;
pub mod lenient_json;
pub mod managed_project_folders;
pub mod migration_050;
pub mod migration_051_054;
pub mod migration_055;
pub mod migration_056_063;
pub mod migration_064_065;
pub mod migration_066;
pub mod migration_067_068;
pub mod migration_069_073;
pub mod migration_074_078;
pub mod migration_079_083;
pub mod migration_084_089;
pub mod migration_steps;
pub mod migrations;
pub mod orchestration_search;
pub mod outbox;
pub mod output_window;
pub mod ownership;
pub mod preview_migration;
pub mod project_commands;
pub mod project_mutation;
pub mod project_setup;
pub mod project_sink;
pub mod project_update;
pub mod provider;
pub mod provider_auth;
pub mod provider_selection;
pub mod queue_ops;
pub mod queue_promotion;
pub mod queue_reorder;
pub mod queue_steer;
pub mod restart_continuation;
pub mod rollback_commands;
pub mod rollback_executor;
pub mod rpc;
pub mod runtime;
pub mod runtime_bootstrap;
pub mod runtime_http;
pub mod runtime_recovery;
pub mod runtime_state;
pub mod scheduled_run_outcome;
pub mod scheduled_tasks;
pub mod server;
pub mod settings;
pub mod shared;
pub mod signing_key;
pub mod startup_access;
pub mod static_client;
pub mod storage_cleanup;
pub mod storage_cleanup_worktrees;
pub mod terminal;
pub mod theme_cli;
pub mod thread_commands;
pub mod thread_lifecycle;
pub mod thread_metadata;
pub mod thread_title;
pub mod thread_title_command;
pub mod thread_visit;
pub mod trace_diagnostics;
pub mod trace_writer;
pub mod transport;
pub mod vcs_parse;
pub mod workspace_rpc;

pub mod vcs_status;
pub mod vcs_worktree;

pub mod thread_controls;

pub mod thread_modes;

pub mod thread_deletion;

pub mod thread_question_dismiss;

pub mod repository_identity;
pub mod request_delivery_failure;

pub mod mcp_pending_request;

pub mod restart_transition;

pub mod webhook_admission;
pub mod webhook_dedupe;
pub mod webhook_deliveries;
pub mod webhook_http;
pub mod webhook_queue;
pub mod webhook_relay_proof;
pub mod webhook_template;
pub mod webhook_verification;
pub mod webhook_worker;

pub mod scheduled_setup;
pub mod scheduled_worktree_journal;

pub mod managed_policy;

pub mod mcp_secret;
pub mod secret_requests;

pub mod tailscale_serve;

pub mod codex_credential_store;
pub mod codex_managed_runtime;
pub mod codex_oauth;
pub mod codex_shadow_home;
pub mod codex_token_broker;

pub mod speech_model_store;
pub mod voice_http;

pub mod codex_release;

pub mod provider_install;

mod github_pinned_credential;
mod gitlab_files_viewed;
mod gitlab_pull_request_activity;
mod gitlab_pull_request_diff;
mod gitlab_pull_request_list;
mod gitlab_pull_request_read;
mod pull_request_actions;
mod pull_request_activity;
mod pull_request_checks;
mod pull_request_comment;
mod pull_request_detail;
mod pull_request_diff;
mod pull_request_file_contents;
mod pull_request_files_viewed;
mod pull_request_filter_options;
mod pull_request_links;
mod pull_request_review_guide;
mod review_guide_claude;
mod review_guide_claude_catalog;
mod review_guide_model;
mod review_guide_prompt;
mod review_guide_schema;
mod pull_request_list;
mod pull_request_preview;
mod pull_request_reaction;
mod pull_request_refresh;
mod pull_request_routing;
mod pull_request_stack;
mod pull_request_stats;
mod pull_request_submit_review;
mod pull_request_summary;
mod pull_request_thread_comments;

mod pull_request_labels;
mod pull_request_reviewers;
mod pull_request_thread_write;

mod device_status;

mod preview_manager;

mod preview_browser;

mod preview_stream;

mod device_hub;

mod preview_discovery;
pub mod service_launcher;
