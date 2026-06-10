"use client";
import { useState } from "react";
import {
    ConfigProvider,
    theme,
    Button,
    InputNumber,
    Card,
    Row,
    Col,
} from "antd";
import "antd/dist/reset.css";

const { darkAlgorithm } = theme;

const mirzya = [
    "mirza",
    "mirza3",
    "mirza2",
    "mirza4",
    "mirza5",
    "mirza7",
    "mirza8",
    "mirza9",
    "mirza10",
    "mirza11",
    "mirza12",
    "mirza13",
    "mirza14",
    "mirza15",
    "mirza16",
    "mirza17",
    "mirza18",
    "mirza19",
    "mirza20",
    "mirza21",
    "mirza22",
    "mirza23",
    "mirza24",
];

export default function Home() {
    const [selected, setSelected] = useState([]);

    const toggle = (client) => {
        setSelected((prev) =>
            prev.includes(client)
                ? prev.filter((c) => c !== client)
                : [...prev, client]
        );
    };

    const selectFirst = (count) => {
        const limited = mirzya.slice(0, count);
        setSelected(limited);
    };

    const selectAll = () => setSelected(mirzya);
    const clearAll = () => setSelected([]);

    return (
        <ConfigProvider
            theme={{
                algorithm: darkAlgorithm,
                token: {
                    colorBgBase: "#1e1e1e",
                    colorTextBase: "#f0f0f0",
                    colorPrimary: "#1677ff",
                    borderRadius: 8,
                },
            }}
        >
            <div
                style={{
                    minHeight: "100vh",
                    background: "#121212",
                    padding: "24px",
                    fontFamily: "Inter, sans-serif",
                    color: "#f0f0f0",
                }}
            >
                <h1 style={{ marginBottom: 16 }}>Select Clients</h1>

                {/* Controls */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        marginBottom: "20px",
                    }}
                >
                    <InputNumber
                        min={1}
                        max={mirzya.length}
                        placeholder="Enter count"
                        onChange={selectFirst}
                    />
                    <Button type="primary" onClick={selectAll}>
                        Select All
                    </Button>
                    <Button onClick={clearAll}>Clear</Button>
                    <div style={{ marginLeft: "auto" }}>
                        Selected: {selected.length}/{mirzya.length}
                    </div>
                </div>

                {/* Client Grid */}
                <Row gutter={[12, 12]}>
                    {mirzya.map((client) => (
                        <Col key={client} xs={12} sm={8} md={6} lg={4}>
                            <Card
                                onClick={() => toggle(client)}
                                hoverable
                                style={{
                                    background: selected.includes(client)
                                        ? "#1677ff33"
                                        : "#1f1f1f",
                                    borderColor: selected.includes(client)
                                        ? "#1677ff"
                                        : "#333",
                                    color: "#fff",
                                    textAlign: "center",
                                    cursor: "pointer",
                                    transition: "all 0.2s ease",
                                }}
                            >
                                {client}
                            </Card>
                        </Col>
                    ))}
                </Row>

                <div style={{ marginTop: 24, opacity: 0.8 }}>
                    <strong>Selected Clients:</strong>{" "}
                    {selected.length > 0 ? selected.join(", ") : "None"}
                </div>
            </div>
        </ConfigProvider>
    );
}
