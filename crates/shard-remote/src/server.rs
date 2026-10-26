//! 服务器地址规则：规范化用户输入，公网只许 https。

use std::fmt;

/// 服务器地址不可用的原因。`Display` 是给人看的一句话（与调用方无关的通用文案）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerAddressError {
    /// 空地址。
    Missing,
    /// 解析不了（附原输入）。
    Invalid(String),
    /// 带了路径或查询串：只允许站点根。
    HasPath,
    /// 带了用户名或密码。
    HasUserInfo,
    /// 公网地址用了明文 http：设备令牌不能明文传输。
    InsecureHttp,
    /// 既不是 http 也不是 https（附协议名）。
    UnsupportedScheme(String),
}

impl fmt::Display for ServerAddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("缺少服务器地址，例如 https://shard.example.com"),
            Self::Invalid(input) => write!(f, "服务器地址无效：{input}"),
            Self::HasPath => f.write_str("服务器地址只写站点，不要带路径，例如 https://shard.example.com"),
            Self::HasUserInfo => f.write_str("服务器地址不能带用户名或密码"),
            Self::InsecureHttp => f.write_str("公网服务器必须用 https，设备令牌不能明文传输"),
            Self::UnsupportedScheme(scheme) => write!(f, "不支持的协议：{scheme}"),
        }
    }
}

impl std::error::Error for ServerAddressError {}

/// 规范化用户输入的服务器地址：缺协议时补 `https://`，去掉结尾斜杠，协议与主机转小写；只允许站点根（不带路径）。
/// 明文 http 只允许本机回环地址（开发与测试），公网地址必须 https，令牌不能明文传输。
///
/// 结果再规范化一次不变（幂等），可以放心地对已保存的地址重复调用。
pub fn normalize_server(input: &str) -> Result<String, ServerAddressError> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err(ServerAddressError::Missing);
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let uri: ureq::http::Uri = with_scheme.parse().map_err(|_| ServerAddressError::Invalid(input.to_string()))?;
    let scheme = uri.scheme_str().unwrap_or_default().to_ascii_lowercase();
    let authority = uri.authority().ok_or_else(|| ServerAddressError::Invalid(input.to_string()))?;
    if !matches!(uri.path(), "" | "/") || uri.query().is_some() {
        return Err(ServerAddressError::HasPath);
    }
    if authority.as_str().contains('@') {
        return Err(ServerAddressError::HasUserInfo);
    }
    let host = authority.host().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let loopback = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    match scheme.as_str() {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err(ServerAddressError::InsecureHttp),
        _ => return Err(ServerAddressError::UnsupportedScheme(scheme)),
    }
    Ok(format!("{scheme}://{}", authority.as_str().to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_are_normalized_and_https_only() {
        assert_eq!(normalize_server("shard.example.com").unwrap(), "https://shard.example.com");
        assert_eq!(normalize_server("  https://Shard.Example.com/  ").unwrap(), "https://shard.example.com");
        assert_eq!(normalize_server("HTTPS://shard.example.com:8443").unwrap(), "https://shard.example.com:8443");
        assert_eq!(normalize_server("http://localhost:8787").unwrap(), "http://localhost:8787");
        assert_eq!(normalize_server("http://127.0.0.1:9000/").unwrap(), "http://127.0.0.1:9000");
        assert_eq!(normalize_server("http://127.8.9.10").unwrap(), "http://127.8.9.10");
        assert_eq!(normalize_server("http://[::1]:8787").unwrap(), "http://[::1]:8787");

        assert_eq!(normalize_server("  "), Err(ServerAddressError::Missing));
        assert_eq!(normalize_server("/"), Err(ServerAddressError::Missing));
        assert_eq!(normalize_server("http://shard.example.com"), Err(ServerAddressError::InsecureHttp));
        assert_eq!(normalize_server("http://192.168.1.2:8787"), Err(ServerAddressError::InsecureHttp));
        assert_eq!(normalize_server("http://localhost.example.com"), Err(ServerAddressError::InsecureHttp));
        assert_eq!(normalize_server("https://shard.example.com/api"), Err(ServerAddressError::HasPath));
        assert_eq!(normalize_server("https://shard.example.com/?x=1"), Err(ServerAddressError::HasPath));
        assert_eq!(normalize_server("https://user:pass@shard.example.com"), Err(ServerAddressError::HasUserInfo));
        assert_eq!(normalize_server("https://user@shard.example.com"), Err(ServerAddressError::HasUserInfo));
        assert_eq!(
            normalize_server("ftp://shard.example.com"),
            Err(ServerAddressError::UnsupportedScheme("ftp".into()))
        );
        assert!(matches!(normalize_server("https://exa mple.com"), Err(ServerAddressError::Invalid(_))));
    }

    #[test]
    fn normalizing_is_idempotent() {
        for input in ["Shard.Example.com/", "http://LOCALHOST:8787", "https://[::1]:1", "http://127.0.0.1:9"] {
            let once = normalize_server(input).unwrap();
            assert_eq!(normalize_server(&once).unwrap(), once);
        }
    }

    #[test]
    fn errors_read_as_plain_sentences() {
        assert_eq!(ServerAddressError::InsecureHttp.to_string(), "公网服务器必须用 https，设备令牌不能明文传输");
        assert_eq!(ServerAddressError::Invalid("x y".into()).to_string(), "服务器地址无效：x y");
        assert_eq!(ServerAddressError::UnsupportedScheme("ftp".into()).to_string(), "不支持的协议：ftp");
    }
}
