"""Planned PostgreSQL switchover without MWS fencing.

The normal failover controller treats an unreachable peer as a failure and may
power it off. A planned switchover is different: the old primary stays alive
and must continue serving API/runner through the new primary. This module
implements the handshake:

1. target verifies it is a streaming standby and advertises its replay LSN;
2. source waits until the target has replayed its WAL, stops API, stops local
   PostgreSQL and publishes `source_stopped`;
3. target promotes, starts API/Caddy/runner and publishes `promoted`;
4. source starts its API through the target's HAProxy on the next tick.

The shared control file is advanced only through `control.py`, so the API
route cannot promote a database directly.
"""

from __future__ import annotations

import logging
import time
from typing import Callable

import control
import postgres

LOG = logging.getLogger("switchover")


class Controller:
    def __init__(
        self,
        *,
        local_node: str,
        peer_node: str,
        timeout_seconds: float,
        storage_ready: Callable[[], bool],
        ensure_services: Callable[[dict], None],
        finish: Callable[[dict], None],
        stop_api: Callable[[], None],
        set_phase: Callable[[dict, str], None],
        save_state: Callable[[dict], None],
    ) -> None:
        self.local_node = local_node
        self.peer_node = peer_node
        self.timeout_seconds = timeout_seconds
        self.storage_ready = storage_ready
        self.ensure_services = ensure_services
        self.finish = finish
        self.stop_api = stop_api
        self.set_phase = set_phase
        self.save_state = save_state

    def tick(self, state: dict) -> bool:
        """Handle an active command; True means the normal failover loop is paused."""
        try:
            command = control.read()
        except RuntimeError as error:
            # A corrupt control file must not unlock normal failover: the source
            # may already be stopping PostgreSQL, and MWS fencing would power it
            # off during a planned handoff. An operator must fix/remove the file.
            LOG.error("не удалось прочитать switchover; failover приостановлен: %s", error)
            return True
        if not command or command.get("action") != "switchover":
            return False

        if command.get("state") in control.TERMINAL_STATES:
            if command.get("target") != self.local_node:
                self._source_terminal(command, state)
            return False

        if command.get("target") not in {self.local_node, self.peer_node}:
            self._fail(command, "неизвестный целевой узел: " + str(command.get("target")))
            return True

        if control.age_seconds(command) > self.timeout_seconds:
            self._fail(command, "switchover не завершился за отведённое время")
            return True

        if command.get("target") == self.local_node:
            return self._target(command, state)
        return self._source(command, state)

    def _target(self, command: dict, state: dict) -> bool:
        phase = command.get("state")
        if phase == "requested":
            if self._local_role() is not False:
                self._fail(command, "целевой узел не является PostgreSQL standby")
                return True
            if not self.storage_ready():
                self._fail(command, "общий storage недоступен на целевом узле")
                return True
            if not postgres.primary_reachable():
                self._fail(command, "текущий primary недоступен с целевого узла")
                return True
            if postgres.wal_receiver_status() != "streaming":
                self._fail(command, "на целевом узле нет streaming WAL receiver")
                return True
            replay = postgres.replay_lsn()
            if not replay:
                self._fail(command, "целевой узел не отдал replay LSN")
                return True
            updated = control.update(
                command["id"], state="target_ready", replayLsn=replay
            )
            if not updated:
                self._fail(command, "не удалось записать target_ready")
            else:
                LOG.warning("switchover: %s готов принять WAL; жду остановки %s", self.local_node, self.peer_node)
            return True

        if phase == "target_ready":
            # Keep the advertised LSN fresh while the source waits for catch-up.
            replay = postgres.replay_lsn()
            if replay and replay != command.get("replayLsn"):
                control.update(command["id"], replayLsn=replay)
            return True

        if phase == "source_stopped":
            if self._local_role() is not False:
                self._fail(command, "целевой узел перестал быть standby до promotion")
                return True
            if not self.storage_ready():
                self._fail(command, "общий storage недоступен перед promotion")
                return True
            try:
                LOG.warning("switchover: повышаю %s после остановки %s", self.local_node, self.peer_node)
                postgres.promote()
                if not postgres.wait_for_primary():
                    self._fail(command, "PostgreSQL не вышел из recovery после promote")
                    return True
            except (RuntimeError, OSError) as error:
                self._fail(command, "promotion не выполнен: " + str(error))
                return True

            self.set_phase(state, "promoted")
            state["promoted_at"] = time.time()
            self.save_state(state)
            control.update(
                command["id"],
                state="promoted",
                promotedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                message="promotion завершён",
            )
            LOG.warning("switchover: %s стал primary; %s остаётся API/runner", self.local_node, self.peer_node)
            self.ensure_services(state)
            self.finish(state)
            return True

        return True

    def _source(self, command: dict, state: dict) -> bool:
        phase = command.get("state")
        if phase in {"source_stopped", "requested"}:
            # The source is waiting for the target or has already stopped. Keep
            # the normal failover loop out of this operation.
            self.ensure_services(state)
            return True

        if phase != "target_ready":
            return True

        if self._local_role() is not True:
            self._fail(command, "источник больше не является primary")
            self.ensure_services(state)
            return True
        if not self.storage_ready():
            self._fail(command, "общий storage недоступен на источнике")
            self.ensure_services(state)
            return True

        target_lsn = command.get("replayLsn")
        if not isinstance(target_lsn, str) or not target_lsn:
            return True
        try:
            source_lsn = postgres.current_lsn()
            if postgres.lsn_diff(source_lsn, target_lsn) > 0:
                return True
        except (RuntimeError, OSError) as error:
            LOG.error("switchover: не удалось сравнить WAL: %s", error)
            return True

        # Stop API first: after this point there must be no application writes
        # that the target could miss between the LSN comparison and PG stop.
        if not command.get("apiStoppedAt"):
            try:
                LOG.warning("switchover: останавливаю API %s перед остановкой PostgreSQL", self.local_node)
                self.stop_api()
            except (RuntimeError, OSError) as error:
                self._fail(command, "не удалось остановить API: " + str(error))
                self.ensure_services(state)
                return True
            updated = control.update(command["id"], apiStoppedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            if not updated:
                self._fail(command, "не удалось записать apiStoppedAt")
                self.ensure_services(state)
                return True
            return True

        # API is stopped; re-read the target's LSN after the final writes are
        # gone. If it is still behind, wait for the next tick.
        try:
            source_lsn = postgres.current_lsn()
            target_lsn = command.get("replayLsn") or ""
            if postgres.lsn_diff(source_lsn, target_lsn) > 0:
                return True
        except (RuntimeError, OSError) as error:
            self._fail(command, "не удалось проверить финальный WAL: " + str(error))
            self.ensure_services(state)
            return True

        try:
            LOG.warning("switchover: останавливаю PostgreSQL на %s; %s станет primary", self.local_node, self.peer_node)
            postgres.stop()
        except (RuntimeError, OSError) as error:
            self._fail(command, "не удалось остановить PostgreSQL: " + str(error))
            self.ensure_services(state)
            return True

        if self._local_role() is not None:
            self._fail(command, "PostgreSQL на источнике всё ещё отвечает после stop")
            self.ensure_services(state)
            return True

        control.update(
            command["id"],
            state="source_stopped",
            stoppedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            message="источник остановлен, можно повышать target",
        )
        LOG.warning("switchover: PostgreSQL на %s остановлен; жду promotion %s", self.local_node, self.peer_node)
        return True

    def _source_terminal(self, command: dict, state: dict) -> None:
        phase = command.get("state")
        if phase == "promoted":
            self.ensure_services(state)
            return
        if phase in {"failed", "rolled_back"}:
            self._rollback_if_stopped(command, state)

    def _rollback_if_stopped(self, command: dict, state: dict) -> None:
        try:
            if self._local_role() is not None:
                self.ensure_services(state)
                return
            LOG.warning("switchover: возвращаю PostgreSQL на %s после неудачи", self.local_node)
            postgres.start()
            if not postgres.wait_for_primary():
                LOG.error("switchover: PostgreSQL на %s не стал primary после rollback", self.local_node)
                return
            control.update(
                command["id"],
                state="rolled_back",
                message="источник возвращён в primary после неудачного switchover",
            )
            self.set_phase(state, "passive")
            self.save_state(state)
            self.ensure_services(state)
        except (RuntimeError, OSError) as error:
            LOG.error("switchover: rollback источника не удался: %s", error)

    def _fail(self, command: dict, message: str) -> None:
        LOG.error("switchover: %s", message)
        control.fail(command["id"], message)

    @staticmethod
    def _local_role() -> bool | None:
        try:
            return not postgres.is_in_recovery()
        except RuntimeError:
            return None
