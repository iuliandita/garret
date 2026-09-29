use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Flushing,
    Holding,
    Completing,
    Approved,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Begin(u64),
    Prevent,
    Allow,
}

struct State {
    phase: Phase,
    attempt: u64,
}

pub struct CloseState(Mutex<State>);

impl Default for CloseState {
    fn default() -> Self {
        Self(Mutex::new(State {
            phase: Phase::Idle,
            attempt: 0,
        }))
    }
}

impl CloseState {
    pub fn request(&self, locked: bool, content_shown: bool) -> Request {
        let Ok(mut state) = self.0.lock() else {
            // A poisoned close state must not authorize window destruction.
            return Request::Prevent;
        };
        match state.phase {
            Phase::Idle if locked && !content_shown => Request::Allow,
            Phase::Idle => {
                state.phase = if locked { Phase::Holding } else { Phase::Flushing };
                Request::Begin(state.attempt)
            }
            Phase::Approved => Request::Allow,
            _ => Request::Prevent,
        }
    }

    pub fn hold(&self, attempt: u64) {
        if let Ok(mut state) = self.0.lock() {
            if state.attempt == attempt && state.phase == Phase::Flushing {
                state.phase = Phase::Holding;
            }
        }
    }

    pub fn release(&self, attempt: u64) {
        if let Ok(mut state) = self.0.lock() {
            if state.attempt == attempt
                && matches!(state.phase, Phase::Flushing | Phase::Holding)
            {
                state.phase = Phase::Idle;
                state.attempt = state.attempt.wrapping_add(1);
            }
        }
    }

    pub fn reset(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.phase = Phase::Idle;
            state.attempt = state.attempt.wrapping_add(1);
        }
    }

    pub fn timeout_release(&self, attempt: u64) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state.attempt == attempt && state.phase == Phase::Flushing {
            state.phase = Phase::Idle;
            state.attempt = state.attempt.wrapping_add(1);
            true
        } else {
            false
        }
    }

    pub fn confirm(&self, attempt: u64, prepare: impl FnOnce(), close: impl FnOnce()) {
        {
            let Ok(mut state) = self.0.lock() else {
                return;
            };
            if state.attempt != attempt || !matches!(state.phase, Phase::Flushing | Phase::Holding)
            {
                return;
            }
            state.phase = Phase::Completing;
        }
        prepare();
        let approved = {
            let Ok(mut state) = self.0.lock() else {
                return;
            };
            if state.attempt == attempt && state.phase == Phase::Completing {
                state.phase = Phase::Approved;
                true
            } else {
                false
            }
        };
        if approved {
            close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CloseState, Phase, Request, State};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    #[test]
    fn repeated_pending_and_held_requests_are_prevented() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        assert_eq!(state.request(false, true), Request::Prevent);
        state.hold(0);
        assert_eq!(state.request(false, true), Request::Prevent);
    }

    #[test]
    fn keep_editing_starts_a_fresh_attempt() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        state.release(0);
        assert_eq!(state.request(false, true), Request::Begin(1));
    }

    #[test]
    fn stale_operations_leave_the_current_attempt_pending() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        state.release(0);
        assert_eq!(state.request(false, true), Request::Begin(1));
        state.hold(0);
        state.release(0);
        let closed = AtomicBool::new(false);
        state.confirm(0, || panic!("stale acknowledgement prepared"), || {
            closed.store(true, Ordering::SeqCst)
        });
        assert!(!closed.load(Ordering::SeqCst));
        assert_eq!(state.request(false, true), Request::Prevent);
        assert!(state.timeout_release(1));
    }

    #[test]
    fn an_idle_state_cannot_be_held_confirmed_or_timed_out() {
        let state = CloseState::default();
        state.hold(0);
        state.release(0);
        state.confirm(0, || panic!("unsolicited acknowledgement prepared"), || {
            panic!("unsolicited acknowledgement closed")
        });
        assert!(!state.timeout_release(0));
        assert_eq!(state.request(false, true), Request::Begin(0));
    }

    #[test]
    fn an_old_preparation_cannot_approve_a_new_preparation() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let state_ref = &state;
            scope.spawn(move || {
                state_ref.confirm(0, || {
                    started_tx.send(()).unwrap();
                    resume_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
                }, || panic!("old preparation closed the newer attempt"));
                finished_tx.send(()).unwrap();
            });
            started_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
            state.reset();
            assert_eq!(state.request(false, true), Request::Begin(1));
            let closed = AtomicBool::new(false);
            state.confirm(1, || {
                resume_tx.send(()).unwrap();
                finished_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
                assert_eq!(state.request(false, true), Request::Prevent);
            }, || closed.store(true, Ordering::SeqCst));
            assert!(closed.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn duplicate_acknowledgement_is_inert() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        let closed = AtomicBool::new(false);
        state.confirm(0, || {}, || closed.store(true, Ordering::SeqCst));
        state.confirm(0, || panic!("duplicate acknowledgement prepared"), || {
            closed.store(false, Ordering::SeqCst)
        });
        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn timeout_releases_only_the_current_unheld_attempt() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        assert!(!state.timeout_release(1));
        state.hold(0);
        assert!(!state.timeout_release(0));
        state.release(0);
        assert_eq!(state.request(false, true), Request::Begin(1));
        assert!(state.timeout_release(1));
        state.confirm(1, || panic!("timed-out acknowledgement prepared"), || panic!("timed-out acknowledgement closed"));
        assert_eq!(state.request(false, true), Request::Begin(2));
    }

    #[test]
    fn timeout_never_grants_close_permission_after_locking() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        assert!(state.timeout_release(0));
        assert_eq!(state.request(true, true), Request::Begin(1));
        assert_eq!(state.request(false, true), Request::Prevent);
        assert!(!state.timeout_release(0));
        assert!(!state.timeout_release(1));
        state.confirm(0, || panic!("old timeout prepared"), || panic!("old timeout closed"));
        let closed = AtomicBool::new(false);
        state.confirm(1, || {}, || closed.store(true, Ordering::SeqCst));
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(state.request(true, true), Request::Allow);
    }

    #[test]
    fn timeout_is_refused_while_confirmation_prepares() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        let closed = AtomicBool::new(false);
        state.confirm(
            0,
            || assert!(!state.timeout_release(0)),
            || closed.store(true, Ordering::SeqCst),
        );
        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn reset_invalidates_an_old_timeout_while_a_fresh_attempt_is_live() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        state.reset();
        assert_eq!(state.request(false, true), Request::Begin(1));
        assert!(!state.timeout_release(0));
        assert_eq!(state.request(false, true), Request::Prevent);
    }

    #[test]
    fn reset_during_preparation_prevents_close() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        let closed = AtomicBool::new(false);
        state.confirm(0, || state.reset(), || closed.store(true, Ordering::SeqCst));
        assert!(!closed.load(Ordering::SeqCst));
        assert_eq!(state.request(false, true), Request::Begin(1));
    }

    #[test]
    fn request_remains_prevented_during_preparation_then_clean_confirm_closes() {
        let state = CloseState::default();
        assert_eq!(state.request(false, true), Request::Begin(0));
        let closed = AtomicBool::new(false);
        state.confirm(
            0,
            || assert_eq!(state.request(false, true), Request::Prevent),
            || closed.store(true, Ordering::SeqCst),
        );
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(state.request(false, true), Request::Allow);
    }

    #[test]
    fn cold_concealed_close_is_allowed() {
        assert_eq!(CloseState::default().request(true, false), Request::Allow);
    }

    #[test]
    fn locked_content_holds_then_accepts_a_valid_confirmation() {
        let state = CloseState::default();
        assert_eq!(state.request(true, true), Request::Begin(0));
        assert!(!state.timeout_release(0));
        let closed = AtomicBool::new(false);
        state.confirm(0, || {}, || closed.store(true, Ordering::SeqCst));
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(state.request(true, true), Request::Allow);
    }

    #[test]
    fn attempts_wrap_like_the_previous_atomic_counter() {
        let state = CloseState(Mutex::new(State {
            phase: Phase::Flushing,
            attempt: u64::MAX,
        }));
        state.release(u64::MAX);
        assert_eq!(state.request(false, true), Request::Begin(0));
    }
}
