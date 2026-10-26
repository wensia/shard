//! Shard 远程客户端的共享实现：命令行（`shard login` 之后的远程模式）与桌面在线客户端用同一份。
//!
//! - [`client`]：带设备令牌调 `POST <服务器>/api/rpc/{命令}`。写请求带新的幂等键，网络失败与 502/503/504
//!   用同一个键重试；都带 `X-Shard-UTC-Offset` 与调用方给的 User-Agent。
//! - [`server`]：服务器地址规则（公网只许 https，回环可 http，拒绝用户名密码与路径）。
//! - [`store`]：本机远程配置（`remote.json`）与设备令牌（macOS 钥匙串或 0600 文件，按服务器区分）。
//!   钥匙串服务名、状态目录与文件名由调用方给：命令行是 `dev.shard.cli`，桌面另用自己的。
//! - [`pairing`]：设备配对协议（`/api/device/start` → 轮询 `/api/device/token`，退避）。
//! - [`sse`]：`GET /api/events` 的阻塞读取与增量解析，`Last-Event-ID` 续传。
//! - [`bytes`]：带令牌读字节（图片、修订原文）与按内容哈希上传附件。
//!
//! 界面与交互策略（只许在终端里登录、切换服务器要确认、提示里写哪条命令）由调用方决定，不在这里。
//! 错误都是这个库自己的类型，文案与调用方无关；调用方按需映射成自己的错误码与提示。

pub mod bytes;
pub mod client;
pub mod pairing;
pub mod server;
pub mod sse;
pub mod store;

#[cfg(test)]
mod test_server;

pub use bytes::{FetchedBytes, MAX_FETCH_BYTES};
pub use client::{decode, idempotency_key, utc_offset_minutes, Client, ClientOptions, RemoteError};
pub use pairing::{start_pairing, DeviceCredentials, Pairing, PairingError, PairingRequest, PollStatus};
pub use server::{normalize_server, ServerAddressError};
pub use sse::{EventStream, SseEvent, SseParser};
pub use store::{CredentialStore, RemoteConfig, StoreError, TokenBackend};
