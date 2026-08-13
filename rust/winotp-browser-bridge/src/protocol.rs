use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const PROTOCOL_VERSION: u64 = 1;
pub const INVALID_REQUEST_ID: &str = "invalid-request";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    AppNotRunning,
    AppLocked,
    AccountNotFound,
    InvalidRequest,
    UnsupportedProtocol,
    NativeHostError,
    InternalError,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestMethod {
    Ping,
    GetStatus,
    ListAccounts,
    GetTotp { account_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeRequest {
    pub request_id: String,
    pub method: RequestMethod,
}

impl NativeRequest {
    pub fn as_value(&self) -> Value {
        match &self.method {
            RequestMethod::Ping => request_value(&self.request_id, "ping", None),
            RequestMethod::GetStatus => request_value(&self.request_id, "getStatus", None),
            RequestMethod::ListAccounts => request_value(&self.request_id, "listAccounts", None),
            RequestMethod::GetTotp { account_id } => request_value(
                &self.request_id,
                "getTotp",
                Some(json!({ "accountId": account_id })),
            ),
        }
    }
}

fn request_value(request_id: &str, method: &str, params: Option<Value>) -> Value {
    let mut request = json!({
        "version": PROTOCOL_VERSION,
        "requestId": request_id,
        "method": method,
    });
    if let Some(params) = params {
        request["params"] = params;
    }
    request
}

#[derive(Debug, PartialEq, Eq)]
pub struct RequestError {
    pub request_id: String,
    pub code: ErrorCode,
    pub message: &'static str,
}

fn valid_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str]) -> bool {
    object.keys().map(String::as_str).collect::<BTreeSet<_>>()
        == expected.iter().copied().collect::<BTreeSet<_>>()
}

fn invalid(request_id: &str, message: &'static str) -> RequestError {
    RequestError {
        request_id: request_id.to_owned(),
        code: ErrorCode::InvalidRequest,
        message,
    }
}

fn safe_error_message(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::AppNotRunning => "WinOTP is not running",
        ErrorCode::AppLocked => "WinOTP is locked",
        ErrorCode::AccountNotFound => "Account not found",
        ErrorCode::InvalidRequest => "Invalid request",
        ErrorCode::UnsupportedProtocol => "Unsupported Native Messaging protocol version",
        ErrorCode::NativeHostError => "The local WinOTP bridge is unavailable",
        ErrorCode::InternalError => "WinOTP could not complete the request",
    }
}

pub fn parse_request(body: &[u8]) -> Result<NativeRequest, RequestError> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| invalid(INVALID_REQUEST_ID, "Malformed JSON request"))?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid(INVALID_REQUEST_ID, "Request must be an object"))?;
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| valid_id(value))
        .unwrap_or(INVALID_REQUEST_ID);

    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(request_id, "Protocol version is required"))?;
    if version != PROTOCOL_VERSION {
        return Err(RequestError {
            request_id: request_id.to_owned(),
            code: ErrorCode::UnsupportedProtocol,
            message: "Unsupported Native Messaging protocol version",
        });
    }

    if request_id == INVALID_REQUEST_ID {
        return Err(invalid(request_id, "Invalid request ID"));
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(request_id, "Method is required"))?;

    let parsed_method = match method {
        "ping" | "getStatus" | "listAccounts" => {
            if !exact_keys(object, &["version", "requestId", "method"]) {
                return Err(invalid(request_id, "Unexpected request fields"));
            }
            match method {
                "ping" => RequestMethod::Ping,
                "getStatus" => RequestMethod::GetStatus,
                _ => RequestMethod::ListAccounts,
            }
        }
        "getTotp" => {
            if !exact_keys(object, &["version", "requestId", "method", "params"]) {
                return Err(invalid(request_id, "Unexpected request fields"));
            }
            let params = object
                .get("params")
                .and_then(Value::as_object)
                .ok_or_else(|| invalid(request_id, "TOTP parameters are required"))?;
            if !exact_keys(params, &["accountId"]) {
                return Err(invalid(request_id, "Invalid TOTP parameters"));
            }
            let account_id = params
                .get("accountId")
                .and_then(Value::as_str)
                .filter(|value| valid_id(value))
                .ok_or_else(|| invalid(request_id, "Invalid account ID"))?;
            RequestMethod::GetTotp {
                account_id: account_id.to_owned(),
            }
        }
        _ => return Err(invalid(request_id, "Unknown method")),
    };

    Ok(NativeRequest {
        request_id: request_id.to_owned(),
        method: parsed_method,
    })
}

pub fn success_response(request_id: &str, result: Value) -> Value {
    json!({
        "version": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "result": result,
    })
}

pub fn error_response(request_id: &str, code: ErrorCode, message: &str) -> Value {
    json!({
        "version": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": { "code": code, "message": message },
    })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BrowserAccount {
    id: String,
    issuer: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AccountsResult {
    accounts: Vec<BrowserAccount>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TotpResult {
    code: String,
    expires_in: u64,
    period: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusResult {
    state: AppState,
    app_version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AppState {
    Locked,
    Unlocked,
}

fn validate_success_result(method: &RequestMethod, result: Value) -> Option<Value> {
    match method {
        RequestMethod::Ping => None,
        RequestMethod::GetStatus => {
            let result: StatusResult = serde_json::from_value(result).ok()?;
            if result.app_version.is_empty() || result.app_version.len() > 64 {
                return None;
            }
            serde_json::to_value(result).ok()
        }
        RequestMethod::ListAccounts => {
            let result: AccountsResult = serde_json::from_value(result).ok()?;
            let mut account_ids = BTreeSet::new();
            if result.accounts.len() > 10_000
                || result.accounts.iter().any(|account| {
                    !valid_id(&account.id)
                        || account.issuer.len() > 256
                        || account.name.is_empty()
                        || account.name.len() > 256
                        || !account_ids.insert(&account.id)
                })
            {
                return None;
            }
            serde_json::to_value(result).ok()
        }
        RequestMethod::GetTotp { .. } => {
            let result: TotpResult = serde_json::from_value(result).ok()?;
            if !(4..=10).contains(&result.code.len())
                || !result.code.bytes().all(|byte| byte.is_ascii_digit())
                || result.expires_in == 0
                || result.period == 0
                || result.period > 300
                || result.expires_in > result.period
            {
                return None;
            }
            serde_json::to_value(result).ok()
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("desktop response failed protocol validation")]
pub struct ResponseValidationError;

pub fn validate_forwarded_response(
    request: &NativeRequest,
    value: Value,
) -> Result<Value, ResponseValidationError> {
    let object = value.as_object().ok_or(ResponseValidationError)?;
    if object.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || object.get("requestId").and_then(Value::as_str) != Some(request.request_id.as_str())
    {
        return Err(ResponseValidationError);
    }
    match object.get("ok").and_then(Value::as_bool) {
        Some(true) if exact_keys(object, &["version", "requestId", "ok", "result"]) => {
            let result = validate_success_result(
                &request.method,
                object
                    .get("result")
                    .cloned()
                    .ok_or(ResponseValidationError)?,
            )
            .ok_or(ResponseValidationError)?;
            Ok(success_response(&request.request_id, result))
        }
        Some(false) if exact_keys(object, &["version", "requestId", "ok", "error"]) => {
            let error = object
                .get("error")
                .and_then(Value::as_object)
                .ok_or(ResponseValidationError)?;
            if !exact_keys(error, &["code", "message"]) {
                return Err(ResponseValidationError);
            }
            let code: ErrorCode =
                serde_json::from_value(error.get("code").cloned().ok_or(ResponseValidationError)?)
                    .map_err(|_| ResponseValidationError)?;
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .ok_or(ResponseValidationError)?;
            if message.is_empty() || message.len() > 256 {
                return Err(ResponseValidationError);
            }
            Ok(error_response(
                &request.request_id,
                code,
                safe_error_message(code),
            ))
        }
        _ => Err(ResponseValidationError),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: Value) -> Result<NativeRequest, RequestError> {
        parse_request(&serde_json::to_vec(&value).unwrap())
    }

    #[test]
    fn parses_all_supported_methods() {
        for (method, expected) in [
            ("ping", RequestMethod::Ping),
            ("getStatus", RequestMethod::GetStatus),
            ("listAccounts", RequestMethod::ListAccounts),
        ] {
            let request =
                parse(json!({ "version": 1, "requestId": "request-1", "method": method })).unwrap();
            assert_eq!(request.method, expected);
        }
        let request = parse(json!({
            "version": 1,
            "requestId": "request-2",
            "method": "getTotp",
            "params": { "accountId": "account-1" }
        }))
        .unwrap();
        assert_eq!(
            request.method,
            RequestMethod::GetTotp {
                account_id: "account-1".to_owned()
            }
        );
    }

    #[test]
    fn rejects_invalid_methods_ids_versions_and_extra_fields() {
        assert_eq!(
            parse(json!({ "version": 1, "requestId": "request-1", "method": "deleteAccount" }))
                .unwrap_err()
                .code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            parse(json!({ "version": 1, "requestId": "request-1", "method": "getTotp", "params": { "accountId": "bad id" } }))
                .unwrap_err()
                .code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            parse(json!({ "version": 2, "requestId": "request-1", "method": "ping" }))
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedProtocol
        );
        assert!(
            parse(
                json!({ "version": 1, "requestId": "request-1", "method": "ping", "secret": "x" })
            )
            .is_err()
        );
    }

    #[test]
    fn malformed_json_is_a_structured_invalid_request() {
        let error = parse_request(br#"{"version":1,"#).unwrap_err();
        assert_eq!(error.request_id, INVALID_REQUEST_ID);
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn account_results_are_allow_listed() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::ListAccounts,
        };
        let unsafe_response = success_response(
            &request.request_id,
            json!({ "accounts": [{ "id": "a", "issuer": "Example", "name": "user", "secret": "never" }] }),
        );
        assert!(validate_forwarded_response(&request, unsafe_response).is_err());

        let duplicate_response = success_response(
            &request.request_id,
            json!({ "accounts": [
                { "id": "duplicate", "issuer": "One", "name": "First" },
                { "id": "duplicate", "issuer": "Two", "name": "Second" }
            ] }),
        );
        assert!(validate_forwarded_response(&request, duplicate_response).is_err());
    }

    #[test]
    fn locked_errors_remain_structured_and_contain_no_account_data() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::ListAccounts,
        };
        let response = error_response(
            &request.request_id,
            ErrorCode::AppLocked,
            "WinOTP is locked",
        );
        let validated = validate_forwarded_response(&request, response).unwrap();
        assert_eq!(validated["error"]["code"], "APP_LOCKED");
        assert!(validated.get("result").is_none());
    }

    #[test]
    fn totp_results_must_be_current_bounded_and_allow_listed() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::GetTotp {
                account_id: "account-1".to_owned(),
            },
        };
        let valid = success_response(
            &request.request_id,
            json!({ "code": "123456", "expiresIn": 18, "period": 30 }),
        );
        assert!(validate_forwarded_response(&request, valid).is_ok());
        for unsafe_result in [
            json!({ "code": "123456", "expiresIn": 0, "period": 30 }),
            json!({ "code": "123456", "expiresIn": 31, "period": 30 }),
            json!({ "code": "123456", "expiresIn": 18, "period": 30, "secret": "never" }),
        ] {
            assert!(
                validate_forwarded_response(
                    &request,
                    success_response(&request.request_id, unsafe_result)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn desktop_error_messages_are_replaced_with_safe_protocol_text() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::GetTotp {
                account_id: "account-1".to_owned(),
            },
        };
        let response = error_response(
            &request.request_id,
            ErrorCode::InternalError,
            "Database failed for secret JBSWY3DPEHPK3PXP at C:\\Users\\example",
        );
        let validated = validate_forwarded_response(&request, response).unwrap();
        assert_eq!(
            validated["error"]["message"],
            "WinOTP could not complete the request"
        );
    }
}
