"""CLI entry point: python -m pipeline.briefing.run"""

from pipeline.briefing.morning import generate_briefing


def main():
    print(generate_briefing())


if __name__ == "__main__":
    main()
