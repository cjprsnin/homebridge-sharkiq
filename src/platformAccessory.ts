import { Service, PlatformAccessory, CharacteristicValue, Logger, uuid } from 'homebridge';

import { SharkIQPlatform } from './platform';
import { Properties, SharkIqVacuum, OperatingModes, PowerModes } from './sharkiq-js/sharkiq';

export class SharkIQAccessory {
  private service: Service;
  private dockedStatusService: Service;
  private vacuumPausedService: Service;
  private goHomeService: Service;

  private lastKnownStates = {
    docked: null as boolean | null,
    active: null as boolean | null,
    powerMode: null as PowerModes | null,
  };

  private retrieveStatesTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: SharkIQPlatform,
    private readonly accessory: PlatformAccessory,
    private device: SharkIqVacuum,
    UUIDGen: typeof uuid,
    private readonly log: Logger,
    private readonly invertDockedStatus: boolean,
    private readonly dockedUpdateInterval: number,
    private dockedDelay: number = 0,
  ) {
    // Get device serial number
    const serial_number = device._dsn;
    const vacuumUUID = UUIDGen.generate(serial_number + '-vacuum');
    this.service = this.accessory.getService(this.platform.Service.Vacuum)
      || this.accessory.addService(this.platform.Service.Vacuum, this.accessory.displayName);

    // Vacuum Name - Default is device name
    this.service.setCharacteristic(this.platform.Characteristic.Name, device._name.toString());

    // Vacuum Active
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setVacuumActive.bind(this))
      .onGet(this.getVacuumActive.bind(this));

    // Vacuum Power (Eco, Normal, Max)
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minStep: 30, // Maps to power levels: ECO, NORMAL, MAX
        minValue: 0, // 0 means off
        maxValue: 90, // 90 means MAX power
      })
      .onSet(this.setVacuumPower.bind(this))
      .onGet(this.getVacuumPower.bind(this));

    // Vacuum Docked Status
    this.dockedStatusService = this.accessory.getService('Vacuum Docked') ||
      this.accessory.addService(this.platform.Service.ContactSensor, 'Vacuum Docked', 'Docked');
    this.dockedStatusService.setCharacteristic(this.platform.Characteristic.Name, `${device._name} Docked`);
    this.dockedStatusService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.retrieveDockedStatus.bind(this));

    // Vacuum Paused Status
    this.vacuumPausedService = this.accessory.getService('Vacuum Paused') ||
      this.accessory.addService(this.platform.Service.Switch, 'Vacuum Paused', 'Paused');
    this.vacuumPausedService.setCharacteristic(this.platform.Characteristic.Name, `${device._name} Paused`);

    this.vacuumPausedService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setPaused.bind(this))
      .onGet(this.getPaused.bind(this));

    // Add "Go Home" Feature
    this.goHomeService = this.accessory.getService('Send to Home') ||
      this.accessory.addService(this.platform.Service.Switch, 'Send to Home', 'GoHome');
    this.goHomeService.setCharacteristic(this.platform.Characteristic.Name, `${device._name} Go Home`);

    this.goHomeService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setGoHome.bind(this))
      .onGet(async (): Promise<boolean> => false); // Always show "Off" as it's a momentary action

    this.updateStates();

    // Retrieve vacuum states with interval and debounce
    this.retrieveVacuumStatesWithInterval();
  }

  // Debounced state retrieval to avoid excessive API calls
  async retrieveVacuumStatesWithDebounce(): Promise<void> {
    if (this.retrieveStatesTimer) {
      clearTimeout(this.retrieveStatesTimer);
    }

    this.retrieveStatesTimer = setTimeout(async () => {
      try {
        await this.retrieveVacuumStates();
      } catch (error) {
        this.log.error('Debounced vacuum state retrieval failed:', error);
      }
    }, this.dockedUpdateInterval);
  }

  // Periodic state retrieval with debounce
  async retrieveVacuumStatesWithInterval(): Promise<void> {
    setInterval(() => {
      this.retrieveVacuumStatesWithDebounce().catch((error) =>
        this.log.error('Periodic vacuum state retrieval failed:', error),
      );
    }, this.dockedUpdateInterval);
  }

  // Retrieve and update vacuum states with state change detection
  async retrieveVacuumStates(): Promise<void> {
    this.log.debug('Triggering GET Vacuum States');

    try {
      await this.device.update([Properties.DOCKED_STATUS, Properties.OPERATING_MODE, Properties.POWER_MODE]);

      const docked_status = this.device.docked_status();
      const vacuumDocked = this.invertDockedStatus ? docked_status !== 1 : docked_status === 1;

      const mode = this.device.operating_mode();
      const vacuumActive = mode === OperatingModes.START || mode === OperatingModes.STOP;

      const powerMode = this.device.power_mode();

      // Update only if state has changed
      if (this.lastKnownStates.docked !== vacuumDocked) {
        this.dockedStatusService.updateCharacteristic(this.platform.Characteristic.ContactSensorState, vacuumDocked);
        this.lastKnownStates.docked = vacuumDocked;
      }

      if (this.lastKnownStates.active !== vacuumActive) {
        const activeCharacteristic = vacuumActive
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE;
        this.service.updateCharacteristic(this.platform.Characteristic.Active, activeCharacteristic);
        this.lastKnownStates.active = vacuumActive;
      }

      if (this.lastKnownStates.powerMode !== powerMode) {
        const rotationSpeed =
          powerMode === PowerModes.MAX ? 90 : powerMode === PowerModes.ECO ? 30 : 60;
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, rotationSpeed);
        this.lastKnownStates.powerMode = powerMode;
      }

      this.log.debug('Vacuum States Updated:', { vacuumDocked, vacuumActive, powerMode });
    } catch (error) {
      this.log.error('Failed to retrieve vacuum states:', error);
    }
  }

  async retrieveDockedStatus(): Promise<boolean> {
    this.log.debug('Triggering GET Docked Status');
    try {
      await this.device.update(Properties.DOCKED_STATUS);
      const docked_status = this.device.docked_status();
      return this.invertDockedStatus ? docked_status !== 1 : docked_status === 1;
    } catch (error) {
      this.log.error('Failed to retrieve docked status:', error);
      return false;
    }
  }

  // Trigger "Go Home" action
  async setGoHome(value: CharacteristicValue): Promise<void> {
    this.log.debug('Triggering SET Go Home:', value);

    if (value) {
      try {
        await this.device.set_operating_mode(OperatingModes.RETURN_TO_BASE);
        this.log.info('Vacuum is returning to its dock.');
      } catch (error) {
        this.log.error('Failed to send vacuum home:', error);
      }

      // Reset the "Go Home" switch to off after the action is triggered
      setTimeout(() => {
        this.goHomeService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 500);
    }
  }

  // ... Remaining methods (setPaused, setVacuumPower, etc.) stay the same.
}
