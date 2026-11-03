#!/usr/bin/env python3
"""
Simulated Cellular IoT Fleet Telemetry Generator & API Gateway Client.

Simulates Nordic LTE-M / NB-IoT / 5G-NR IoT devices sending JSON telemetry
to AWS API Gateway (POST /v1/telemetry), including configurable out-of-range
sensor anomalies and silent-device heartbeat dropouts.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

CONTRACT_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent / "contracts" / "telemetry-request.schema.json"
)


@dataclass(frozen=True)
class DeviceProfile:
    device_id: str
    rat: str
    cell_id: str
    firmware_version: str
    base_temp_c: float
    base_humidity_pct: float
    base_battery_pct: float
    lat: float
    lon: float


DEFAULT_FLEET: tuple[DeviceProfile, ...] = (
    DeviceProfile(
        device_id="iot-se-gbg-001",
        rat="LTE-M",
        cell_id="SE-GBG-CELL-09",
        firmware_version="2.4.1",
        base_temp_c=4.2,
        base_humidity_pct=56.0,
        base_battery_pct=92.0,
        lat=57.7089,
        lon=11.9746,
    ),
    DeviceProfile(
        device_id="iot-se-sto-002",
        rat="NB-IoT",
        cell_id="SE-STO-CELL-14",
        firmware_version="2.4.1",
        base_temp_c=18.5,
        base_humidity_pct=44.0,
        base_battery_pct=86.5,
        lat=59.3293,
        lon=18.0686,
    ),
    DeviceProfile(
        device_id="iot-no-osl-003",
        rat="5G-NR",
        cell_id="NO-OSL-CELL-03",
        firmware_version="2.5.0",
        base_temp_c=-6.0,
        base_humidity_pct=62.0,
        base_battery_pct=78.0,
        lat=59.9139,
        lon=10.7522,
    ),
    DeviceProfile(
        device_id="iot-se-mmx-004",
        rat="LTE-M",
        cell_id="SE-MMX-CELL-11",
        firmware_version="2.3.8",
        base_temp_c=11.4,
        base_humidity_pct=68.0,
        base_battery_pct=64.0,
        lat=55.6050,
        lon=13.0038,
    ),
    DeviceProfile(
        device_id="iot-no-trd-005",
        rat="NB-IoT",
        cell_id="NO-TRD-CELL-02",
        firmware_version="2.4.1",
        base_temp_c=7.8,
        base_humidity_pct=74.0,
        base_battery_pct=89.0,
        lat=63.4305,
        lon=10.3951,
    ),
)


def load_contract_schema(schema_path: Path = CONTRACT_SCHEMA_PATH) -> dict[str, Any]:
    with schema_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def validate_payload_against_contract(
    payload: dict[str, Any],
    schema: dict[str, Any] | None = None,
) -> list[str]:
    """
    Validates a telemetry dictionary against contracts/telemetry-request.schema.json.
    Returns a list of human-readable validation error strings (empty if valid).
    """
    active_schema = schema or load_contract_schema()
    errors: list[str] = []

    if not isinstance(payload, dict):
        return ["Root payload must be a JSON object"]

    required_fields = active_schema.get("required", [])
    allowed_props = set(active_schema.get("properties", {}).keys())

    for req in required_fields:
        if req not in payload:
            errors.append(f"Missing required field: '{req}'")

    if active_schema.get("additionalProperties") is False:
        for key in payload:
            if key not in allowed_props:
                errors.append(f"Unexpected additional property: '{key}'")

    device_id = payload.get("deviceId")
    if isinstance(device_id, str):
        pattern = active_schema["properties"]["deviceId"]["pattern"]
        if not re.match(pattern, device_id):
            errors.append(f"Invalid deviceId format: '{device_id}'")
    elif "deviceId" in payload:
        errors.append("Field 'deviceId' must be a string")

    timestamp = payload.get("timestamp")
    if isinstance(timestamp, str):
        try:
            datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"Invalid ISO-8601 timestamp: '{timestamp}'")
    elif "timestamp" in payload:
        errors.append("Field 'timestamp' must be an ISO-8601 string")

    seq = payload.get("sequenceNumber")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        errors.append("Field 'sequenceNumber' must be an integer >= 1")

    fw = payload.get("firmwareVersion")
    if isinstance(fw, str):
        fw_pattern = active_schema["properties"]["firmwareVersion"]["pattern"]
        if not re.match(fw_pattern, fw):
            errors.append(f"Invalid firmwareVersion: '{fw}'")
    elif "firmwareVersion" in payload:
        errors.append("Field 'firmwareVersion' must be a string")

    network = payload.get("network")
    if isinstance(network, dict):
        net_schema = active_schema["properties"]["network"]
        for req in net_schema.get("required", []):
            if req not in network:
                errors.append(f"Missing required field: 'network.{req}'")
        for key in network:
            if key not in net_schema["properties"]:
                errors.append(f"Unexpected additional property: 'network.{key}'")
        rat = network.get("rat")
        if rat not in net_schema["properties"]["rat"]["enum"]:
            errors.append(f"Invalid network.rat: '{rat}'")
        rssi = network.get("rssiDbm")
        if not isinstance(rssi, (int, float)) or isinstance(rssi, bool) or not (-140 <= rssi <= -30):
            errors.append(f"Invalid network.rssiDbm: '{rssi}'")
        cell_id = network.get("cellId")
        if not isinstance(cell_id, str) or not re.match(
            net_schema["properties"]["cellId"]["pattern"], cell_id
        ):
            errors.append(f"Invalid network.cellId: '{cell_id}'")
    elif "network" in payload:
        errors.append("Field 'network' must be an object")

    metrics = payload.get("metrics")
    if isinstance(metrics, dict):
        met_schema = active_schema["properties"]["metrics"]
        for req in met_schema.get("required", []):
            if req not in metrics:
                errors.append(f"Missing required field: 'metrics.{req}'")
        for key in metrics:
            if key not in met_schema["properties"]:
                errors.append(f"Unexpected additional property: 'metrics.{key}'")
        temp = metrics.get("temperatureC")
        if not isinstance(temp, (int, float)) or isinstance(temp, bool) or not (-80 <= temp <= 150):
            errors.append(f"Invalid metrics.temperatureC: '{temp}'")
        hum = metrics.get("humidityPct")
        if not isinstance(hum, (int, float)) or isinstance(hum, bool) or not (0 <= hum <= 100):
            errors.append(f"Invalid metrics.humidityPct: '{hum}'")
        bat = metrics.get("batteryPct")
        if not isinstance(bat, (int, float)) or isinstance(bat, bool) or not (0 <= bat <= 100):
            errors.append(f"Invalid metrics.batteryPct: '{bat}'")
        if "vibrationG" in metrics:
            vib = metrics["vibrationG"]
            if not isinstance(vib, (int, float)) or isinstance(vib, bool) or not (0 <= vib <= 32):
                errors.append(f"Invalid metrics.vibrationG: '{vib}'")
    elif "metrics" in payload:
        errors.append("Field 'metrics' must be an object")

    return errors


def build_telemetry_payload(
    profile: DeviceProfile,
    sequence_number: int,
    sample_time: datetime,
    rng: random.Random,
    inject_out_of_range: bool = False,
) -> dict[str, Any]:
    """Builds a single cellular IoT telemetry frame conforming to the API contract."""
    if inject_out_of_range:
        # Inject critical thermal spike, critical low battery, and shock vibration
        temperature_c = round(rng.uniform(56.0, 68.0), 2)
        humidity_pct = round(rng.uniform(92.0, 98.0), 2)
        battery_pct = round(rng.uniform(3.5, 6.8), 2)
        vibration_g = round(rng.uniform(5.2, 9.8), 2)
        rssi_dbm = round(rng.uniform(-122.0, -116.0), 1)
    else:
        temperature_c = round(profile.base_temp_c + rng.uniform(-1.5, 1.5), 2)
        humidity_pct = round(
            min(88.0, max(15.0, profile.base_humidity_pct + rng.uniform(-3.0, 3.0))), 2
        )
        battery_pct = round(
            max(20.0, profile.base_battery_pct - (sequence_number - 1) * 0.15), 2
        )
        vibration_g = round(rng.uniform(0.05, 0.85), 2)
        rssi_dbm = round(rng.uniform(-95.0, -68.0), 1)

    iso_ts = sample_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    return {
        "deviceId": profile.device_id,
        "timestamp": iso_ts,
        "sequenceNumber": sequence_number,
        "firmwareVersion": profile.firmware_version,
        "network": {
            "rat": profile.rat,
            "rssiDbm": rssi_dbm,
            "cellId": profile.cell_id,
        },
        "metrics": {
            "temperatureC": temperature_c,
            "humidityPct": humidity_pct,
            "batteryPct": battery_pct,
            "vibrationG": vibration_g,
        },
        "location": {
            "lat": profile.lat,
            "lon": profile.lon,
        },
    }


def send_telemetry_http(
    endpoint_url: str,
    payload: dict[str, Any],
    api_key: str | None = None,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    """Sends a telemetry payload via HTTP POST to AWS API Gateway."""
    correlation_id = f"sim-{payload['deviceId']}-{payload['sequenceNumber']}-{uuid.uuid4().hex[:8]}"
    body_bytes = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-Correlation-Id": correlation_id,
    }
    if api_key:
        headers["x-api-key"] = api_key

    req = urllib.request.Request(
        endpoint_url,
        data=body_bytes,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
            return {
                "statusCode": response.status,
                "body": json.loads(raw) if raw else {},
                "correlationId": correlation_id,
            }
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        return {
            "statusCode": exc.code,
            "body": json.loads(err_body) if err_body.startswith("{") else {"raw": err_body},
            "correlationId": correlation_id,
        }


@dataclass
class SimulationSummary:
    total_devices: int
    rounds: int
    messages_sent: int
    healthy_messages: int
    anomalous_messages: int
    silent_devices: list[str]
    contract_violations: int
    frames: list[dict[str, Any]]


def run_fleet_simulation(
    fleet: tuple[DeviceProfile, ...] = DEFAULT_FLEET,
    rounds: int = 4,
    seed: int = 42,
    inject_out_of_range_device: str | None = "iot-se-gbg-001",
    inject_silent_device: str | None = "iot-no-osl-003",
    start_time: datetime | None = None,
    interval_seconds: int = 180,
    sender: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> SimulationSummary:
    """
    Executes a multi-round IoT fleet simulation.
    - If `inject_silent_device` is set, that device transmits only in round 1 and then goes silent.
    - If `inject_out_of_range_device` is set, that device reports out-of-range values on the final round.
    """
    rng = random.Random(seed)
    schema = load_contract_schema()
    base_time = start_time or datetime(2026, 11, 2, 18, 0, 0, tzinfo=timezone.utc)

    frames: list[dict[str, Any]] = []
    healthy_count = 0
    anomalous_count = 0
    contract_violations = 0
    silent_devices: list[str] = []

    for round_idx in range(1, rounds + 1):
        sample_time = base_time + timedelta(seconds=(round_idx - 1) * interval_seconds)

        for profile in fleet:
            if inject_silent_device and profile.device_id == inject_silent_device and round_idx > 1:
                if profile.device_id not in silent_devices:
                    silent_devices.append(profile.device_id)
                continue

            is_anomaly_round = (
                inject_out_of_range_device == profile.device_id and round_idx == rounds
            )

            payload = build_telemetry_payload(
                profile=profile,
                sequence_number=round_idx,
                sample_time=sample_time,
                rng=rng,
                inject_out_of_range=is_anomaly_round,
            )

            validation_errors = validate_payload_against_contract(payload, schema)
            if validation_errors:
                contract_violations += len(validation_errors)

            if is_anomaly_round:
                anomalous_count += 1
            else:
                healthy_count += 1

            response_meta = sender(payload) if sender else {"statusCode": 202, "mode": "dry-run"}
            frames.append(
                {
                    "round": round_idx,
                    "injectedAnomaly": is_anomaly_round,
                    "contractValid": len(validation_errors) == 0,
                    "payload": payload,
                    "response": response_meta,
                }
            )

    return SimulationSummary(
        total_devices=len(fleet),
        rounds=rounds,
        messages_sent=len(frames),
        healthy_messages=healthy_count,
        anomalous_messages=anomalous_count,
        silent_devices=silent_devices,
        contract_violations=contract_violations,
        frames=frames,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simulate cellular IoT fleet sending telemetry to AWS API Gateway"
    )
    parser.add_argument(
        "--endpoint",
        type=str,
        default=None,
        help="Live API Gateway URL (e.g. https://<id>.execute-api.eu-north-1.amazonaws.com/v1/telemetry). Omit for local dry-run.",
    )
    parser.add_argument("--rounds", type=int, default=4, help="Number of transmission rounds")
    parser.add_argument("--seed", type=int, default=42, help="Deterministic RNG seed")
    parser.add_argument(
        "--anomaly-device",
        type=str,
        default="iot-se-gbg-001",
        help="Device ID to inject out-of-range telemetry on the final round",
    )
    parser.add_argument(
        "--silent-device",
        type=str,
        default="iot-no-osl-003",
        help="Device ID that goes silent after round 1",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="reports/simulation_run.json",
        help="Path to write JSON simulation report",
    )
    args = parser.parse_args()

    sender_fn = (
        (lambda payload: send_telemetry_http(args.endpoint, payload))
        if args.endpoint
        else None
    )

    summary = run_fleet_simulation(
        rounds=args.rounds,
        seed=args.seed,
        inject_out_of_range_device=args.anomaly_device,
        inject_silent_device=args.silent_device,
        sender=sender_fn,
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(asdict(summary), handle, indent=2)

    print(
        json.dumps(
            {
                "event": "SIMULATION_COMPLETED",
                "totalDevices": summary.total_devices,
                "rounds": summary.rounds,
                "messagesSent": summary.messages_sent,
                "healthyMessages": summary.healthy_messages,
                "anomalousMessages": summary.anomalous_messages,
                "silentDevices": summary.silent_devices,
                "contractViolations": summary.contract_violations,
                "reportPath": str(output_path),
            }
        )
    )
    return 0 if summary.contract_violations == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
