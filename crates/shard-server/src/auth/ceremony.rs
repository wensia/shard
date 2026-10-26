//! 进行中的通行密钥仪式（注册 / 登录 / 二次验证）。状态只放内存，5 分钟过期；
//! 客户端拿 `ceremonyId` 回来完成。服务重启会让进行中的仪式失效，重新点一次即可。

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use webauthn_rs::prelude::{PasskeyAuthentication, PasskeyRegistration};

use super::tokens::random_token;

const CEREMONY_TTL: Duration = Duration::from_secs(300);

pub enum Ceremony {
    /// `setup_token` 有值：首次设置或恢复，用一次性令牌授权；为空：已登录用户添加通行密钥。
    Register { state: PasskeyRegistration, setup_token: Option<String> },
    Login { state: PasskeyAuthentication },
    StepUp { state: PasskeyAuthentication, session: Vec<u8> },
}

#[derive(Default)]
pub struct Ceremonies {
    pending: Mutex<HashMap<String, (Instant, Ceremony)>>,
}

impl Ceremonies {
    pub fn begin(&self, ceremony: Ceremony) -> String {
        let id = random_token();
        let now = Instant::now();
        let mut pending = self.pending.lock().expect("仪式表锁中毒");
        pending.retain(|_, (created, _)| now.duration_since(*created) < CEREMONY_TTL);
        pending.insert(id.clone(), (now, ceremony));
        id
    }

    /// 一次性取出；过期或不存在返回 None。
    pub fn take(&self, id: &str) -> Option<Ceremony> {
        let mut pending = self.pending.lock().expect("仪式表锁中毒");
        let (created, ceremony) = pending.remove(id)?;
        (created.elapsed() < CEREMONY_TTL).then_some(ceremony)
    }
}
